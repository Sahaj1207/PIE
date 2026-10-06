// Phase 12 — standalone tests for android/app/src/main/cpp/pdfium/pie_bridge_core.h
//
// Not part of the Gradle/CMake app build. Run during final verification with any C++20
// compiler (no JNI / PDFium needed), for example:
//
//   g++ -std=c++20 -Wall -Wextra -I android/app/src/main/cpp/pdfium \
//       android/app/src/test/cpp/pie_bridge_core_test.cpp -o pie_core_test && ./pie_core_test
//
// Exit code 0 = all checks passed.

#include "pie_bridge_core.h"

#include <cstdio>
#include <string>
#include <vector>

namespace {

int g_failures = 0;
int g_checks = 0;

void check(bool condition, const char* what) {
    ++g_checks;
    if (!condition) {
        ++g_failures;
        std::printf("FAIL: %s\n", what);
    }
}

// UTF-8 literals built from explicit bytes so the test does not depend on source encoding.
const std::string kTokyo = "\xE6\x9D\xB1\xE4\xBA\xAC";            // U+6771 U+4EAC
const std::string kGrinning = "\xF0\x9F\x98\x80";                 // U+1F600 (non-BMP)
const std::string kThumbsMedium = "\xF0\x9F\x91\x8D\xF0\x9F\x8F\xBD";  // U+1F44D U+1F3FD
const std::string kEAcute = "\xC3\xA9";                             // U+00E9
const std::string kReplacement = "\xEF\xBF\xBD";                    // U+FFFD

std::vector<pie::EditCommand> parseOk(const std::string& json) {
    std::vector<pie::EditCommand> commands;
    std::string error;
    const bool ok = pie::parseEditCommands(json, commands, error);
    check(ok, ("parse should succeed: " + json + " error=" + error).c_str());
    return commands;
}

bool parseFails(const std::string& json) {
    std::vector<pie::EditCommand> commands;
    std::string error;
    return !pie::parseEditCommands(json, commands, error) && !error.empty() && commands.empty();
}

void testJsonEscapes() {
    // newline, quotes, backslashes, tab, slash
    auto cmds = parseOk(R"([{"type":"replace","objectId":"p0_path1","pageIndex":0,"objectIndex":1,)"
                        R"("newText":"He said \"hi\"\nC:\\path\\file\t\/end"}])");
    check(cmds.size() == 1, "one command parsed");
    check(cmds[0].newText == "He said \"hi\"\nC:\\path\\file\t/end", "escapes decoded exactly");

    // \u escapes: BMP (CJK, accented) and a surrogate pair (emoji)
    cmds = parseOk(R"([{"type":"replace","newText":"東京 café 😀"}])");
    check(cmds[0].newText == kTokyo + " caf" + kEAcute + " " + kGrinning, "unicode escapes + surrogate pair -> UTF-8");

    // Raw UTF-8 (what JSON.stringify produces) passes through unchanged
    cmds = parseOk("[{\"type\":\"insert\",\"text\":\"" + kTokyo + kGrinning + kThumbsMedium + "\"}]");
    check(cmds[0].text == kTokyo + kGrinning + kThumbsMedium, "raw UTF-8 preserved");

    // Lone surrogates never produce invalid UTF-8
    cmds = parseOk(R"([{"type":"replace","newText":"a\ud83db"}])");
    check(cmds[0].newText == "a" + kReplacement + "b", "lone high surrogate -> U+FFFD");
    cmds = parseOk(R"([{"type":"replace","newText":"\ude00"}])");
    check(cmds[0].newText == kReplacement, "lone low surrogate -> U+FFFD");

    // The old parser treated "\n" as "n" and "é" as "u00e9"
    check(cmds.size() == 1, "sanity");
}

void testKeyShadowingAndStructure() {
    // User text that LOOKS like another key must not be mistaken for it.
    auto cmds = parseOk(R"([{"type":"replace","originalText":"\"newText\":\"evil\"","newText":"real"}])");
    check(cmds[0].newText == "real", "key inside a string value is not a key");
    check(cmds[0].originalText == "\"newText\":\"evil\"", "originalText kept verbatim");

    // Insert: top-level x/y are PDF coordinates; bounds.x/y must not leak into them,
    // regardless of key order.
    cmds = parseOk(R"([{"type":"insert","objectId":"p0_ins_1","pageIndex":0,"bounds":{"x":11,"y":22,"width":5,"height":5},)"
                   R"("text":"Hi","x":72.5,"y":700.25,"fontSize":13,"fontName":"Times-Roman","color":"#FF0000"}])");
    check(cmds[0].x == 72.5 && cmds[0].y == 700.25, "insert x/y read from the command, not from bounds");
    check(cmds[0].fontSize == 13.0 && cmds[0].fontName == "Times-Roman", "insert font fields");
    check(cmds[0].hasColor && cmds[0].colorR == 255 && cmds[0].colorG == 0 && cmds[0].colorB == 0, "hex color parsed");

    // Nested format object
    cmds = parseOk(R"([{"type":"replace","newText":"x","objectPath":[3,1],"format":{"fontSize":9.5,"isBold":true,"isItalic":false,"color":"#00FF0080","fontFamily":"Courier"}}])");
    check(cmds[0].objectPath.size() == 2 && cmds[0].objectPath[0] == 3 && cmds[0].objectPath[1] == 1, "objectPath");
    check(cmds[0].hasFontSize && cmds[0].fontSize == 9.5, "format.fontSize");
    check(cmds[0].hasBold && cmds[0].isBold && cmds[0].hasItalic && !cmds[0].isItalic, "format bold/italic");
    check(cmds[0].colorG == 255 && cmds[0].colorA == 128 && cmds[0].fontFamily == "Courier", "format color/family");

    // Defaults unchanged from the previous parser
    cmds = parseOk(R"([{"type":"delete","objectId":"p0_path0"}])");
    check(cmds[0].pageIndex == 0 && cmds[0].objectIndex == 0 && cmds[0].fontSize == 14.0 && cmds[0].colorA == 255,
          "defaults");

    // Entries without a type are skipped (previous behaviour)
    cmds = parseOk(R"([{"objectId":"x"},{"type":"delete","objectId":"y"}])");
    check(cmds.size() == 1 && cmds[0].objectId == "y", "untyped entries skipped");
}

void testCopyAndMalformedBatches() {
    // copyDocument sends "[]": valid, zero commands
    auto cmds = parseOk("[]");
    check(cmds.empty(), "empty batch = zero commands");
    cmds = parseOk("  [ ]  ");
    check(cmds.empty(), "whitespace around empty batch");

    // Malformed batches must be errors, never a silent zero-command copy
    check(parseFails(""), "empty string rejected");
    check(parseFails("[{\"type\":\"replace\",\"newText\":\"unterminated}]"), "unterminated string rejected");
    check(parseFails("[{\"type\":\"replace\"},]"), "trailing comma rejected");
    check(parseFails("[{\"type\":\"replace\",\"newText\":\"bad \\q escape\"}]"), "invalid escape rejected");
    check(parseFails("[{\"type\":\"replace\",\"newText\":\"raw\nnewline\"}]"), "raw control character rejected");
    check(parseFails("[1,2]"), "non-object entries rejected");
    check(parseFails("\"just a string\""), "non-array root rejected");
    check(parseFails("[{\"type\":\"replace\"}] trailing"), "trailing garbage rejected");
}

void testUtf8Utf16() {
    const std::string all = "A" + kEAcute + kTokyo + kGrinning + kThumbsMedium;
    const std::vector<uint16_t> units = pie::utf8ToUtf16(all);
    // A, e-acute, 2 CJK = 4 units; emoji = 2 units each (3 emoji code points) = 6
    check(units.size() == 10, "UTF-16 unit count incl. surrogate pairs");
    check(units[4] == 0xD83D && units[5] == 0xDE00, "U+1F600 encoded as surrogate pair");
    check(pie::utf16ToUtf8(units.data(), units.size(), false) == all, "UTF-8 -> UTF-16 -> UTF-8 round trip");

    // Standard 4-byte UTF-8, never the JNI "modified UTF-8" 6-byte surrogate form
    const std::string emoji = pie::utf16ToUtf8(units.data() + 4, 2, false);
    check(emoji.size() == 4 && emoji == kGrinning, "non-BMP character -> 4-byte UTF-8");

    const uint16_t lone[] = {0x0041, 0xD800, 0x0042};
    check(pie::utf16ToUtf8(lone, 3, false) == "A" + kReplacement + "B", "lone surrogate -> U+FFFD");

    const uint16_t withNul[] = {0x0041, 0x0000, 0x0042};
    check(pie::utf16ToUtf8(withNul, 3, true) == "A", "stops at NUL for PDFium buffers");

    // Invalid UTF-8 never swallows following characters
    const std::string invalid = std::string("\xC3", 1) + "A";  // truncated sequence then 'A'
    const std::vector<uint16_t> inv = pie::utf8ToUtf16(invalid);
    check(inv.size() == 2 && inv[0] == 0xFFFD && inv[1] == 'A', "invalid UTF-8 -> U+FFFD, next char kept");
    // Modified-UTF-8 surrogate halves (CESU) are rejected rather than producing garbage
    const std::string cesu = "\xED\xA0\xBD";
    check(pie::utf8ToUtf16(cesu).size() == 3, "CESU-8 surrogate bytes are not decoded as a surrogate");

    // JSON output escaping keeps UTF-8 and escapes control characters
    check(pie::escapeJsonString("a\"b\\c\n" + kTokyo) == "a\\\"b\\\\c\\n" + kTokyo, "escapeJsonString");
}

pie::PageVerifyInput edit(const std::string& type, const std::string& pre, const std::string& requested,
                          bool found = false, const std::string& objectText = "") {
    pie::PageVerifyInput e;
    e.type = type;
    e.preText = pre;
    e.newText = requested;
    e.objectFound = found;
    e.objectText = objectText;
    return e;
}

void testVerificationDuplicates() {
    const std::vector<std::string> before = {"Total", "Subtotal", "Total", "Tax"};

    // Delete ONE of two "Total": correct output still contains the other one -> verified.
    // (The old check failed this because "Total" was still present.)
    {
        std::vector<pie::PageVerifyInput> edits = {edit("delete", "Total", "")};
        pie::verifyPageEdits(before, {"Subtotal", "Total", "Tax"}, edits);
        check(edits[0].verified, "deleting one duplicate is verified");
    }
    // Delete that did not happen -> not verified
    {
        std::vector<pie::PageVerifyInput> edits = {edit("delete", "Total", "")};
        pie::verifyPageEdits(before, before, edits);
        check(!edits[0].verified && !edits[0].error.empty(), "failed delete of a duplicate is not verified");
    }
    // Replace "Tax" -> "Total" while "Total" already exists elsewhere: the replacement was
    // NOT written. The old substring check passed this; counts catch it.
    {
        std::vector<pie::PageVerifyInput> edits = {edit("replace", "Tax", "Total", true, "Tax")};
        pie::verifyPageEdits(before, before, edits);
        check(!edits[0].verified, "dropped replacement hidden by duplicate text is not verified");
    }
    // Same replacement written correctly -> verified
    {
        std::vector<pie::PageVerifyInput> edits = {edit("replace", "Tax", "Total", true, "Total")};
        pie::verifyPageEdits(before, {"Total", "Subtotal", "Total", "Total"}, edits);
        check(edits[0].verified, "correct replacement next to duplicates is verified");
    }
    // Object at the edited location holds a superset (substring) of the request -> not verified
    {
        std::vector<pie::PageVerifyInput> edits = {edit("replace", "Tax", "Total", true, "Total Tax")};
        pie::verifyPageEdits(before, {"Total", "Subtotal", "Total", "Total Tax"}, edits);
        check(!edits[0].verified, "substring match is not a verification");
    }
    // Lost glyphs (requested text not what the reopened object contains) -> not verified
    {
        std::vector<pie::PageVerifyInput> edits = {edit("replace", "Tax", "Caf" + kEAcute, true, "Caf")};
        pie::verifyPageEdits(before, {"Total", "Subtotal", "Total", "Caf"}, edits);
        check(!edits[0].verified, "altered text is not verified");
    }
    // Edited object missing at its expected location -> not verified
    {
        std::vector<pie::PageVerifyInput> edits = {edit("replace", "Tax", "VAT", false, "")};
        pie::verifyPageEdits(before, {"Total", "Subtotal", "Total", "VAT"}, edits);
        check(!edits[0].verified, "missing edited object is not verified");
    }
    // Replacement whose old text survived elsewhere unexpectedly -> not verified
    {
        std::vector<pie::PageVerifyInput> edits = {edit("replace", "Tax", "VAT", true, "VAT")};
        pie::verifyPageEdits(before, {"Total", "Subtotal", "Total", "VAT", "Tax"}, edits);
        check(!edits[0].verified, "old text count mismatch is not verified");
    }
    // Insert duplicate of existing text -> verified only with the exact count
    {
        std::vector<pie::PageVerifyInput> edits = {edit("insert", "", "Total", true, "Total")};
        pie::verifyPageEdits(before, {"Total", "Subtotal", "Total", "Tax", "Total"}, edits);
        check(edits[0].verified, "inserted duplicate verified");
        std::vector<pie::PageVerifyInput> missing = {edit("insert", "", "Total", true, "Total")};
        pie::verifyPageEdits(before, before, missing);
        check(!missing[0].verified, "insert not written is not verified even though the text exists");
    }
    // Multiple edits on one page combine expectations
    {
        std::vector<pie::PageVerifyInput> edits = {
            edit("delete", "Total", ""),
            edit("replace", "Tax", "Total", true, "Total"),
        };
        pie::verifyPageEdits(before, {"Total", "Subtotal", "Total"}, edits);
        check(edits[0].verified && edits[1].verified, "delete + replace on the same page");
    }
    // Text-less object deletion is checked through the object count
    {
        std::vector<pie::PageVerifyInput> edits = {edit("delete", "", "")};
        pie::verifyPageEdits({"A", ""}, {"A"}, edits);
        check(edits[0].verified, "text-less delete verified by count");
        std::vector<pie::PageVerifyInput> failed = {edit("delete", "", "")};
        pie::verifyPageEdits({"A", ""}, {"A", ""}, failed);
        check(!failed[0].verified, "text-less delete not applied");
    }
    // Unicode, emoji and escaped text compare exactly; surrounding whitespace is ignored
    {
        const std::string requested = "He said \"hi\" " + kTokyo + " " + kGrinning;
        std::vector<pie::PageVerifyInput> edits = {edit("replace", "Tax", requested, true, requested + " ")};
        pie::verifyPageEdits(before, {"Total", "Subtotal", "Total", requested + " "}, edits);
        check(edits[0].verified, "unicode replacement verified (trailing pad ignored)");
    }
}

// Phase 15: standard-font (WinAnsi) coverage and readable glyph errors
void testGlyphCoverage() {
    check(pie::isWinAnsiEncodable('A') && pie::isWinAnsiEncodable(' ') && pie::isWinAnsiEncodable('~'), "ASCII printable");
    check(pie::isWinAnsiEncodable(0xE9) && pie::isWinAnsiEncodable(0xFC) && pie::isWinAnsiEncodable(0xA0), "Latin-1");
    check(pie::isWinAnsiEncodable(0x20AC) && pie::isWinAnsiEncodable(0x2014) && pie::isWinAnsiEncodable(0x2122), "Win-1252 extras");
    check(!pie::isWinAnsiEncodable('\n') && !pie::isWinAnsiEncodable('\t') && !pie::isWinAnsiEncodable(0x7F), "controls");
    check(!pie::isWinAnsiEncodable(0x6771) && !pie::isWinAnsiEncodable(0x0416) && !pie::isWinAnsiEncodable(0x0915), "CJK/Cyrillic/Devanagari");
    check(!pie::isWinAnsiEncodable(0x1F600), "emoji");

    check(pie::findNonWinAnsiCodePoints("Caf" + kEAcute + " 100 \xE2\x82\xAC").empty(), "Latin text with euro passes");
    const std::vector<uint32_t> missing = pie::findNonWinAnsiCodePoints(kTokyo + kTokyo + "a\n" + kGrinning);
    check(missing.size() == 4 && missing[0] == 0x6771 && missing[1] == 0x4EAC && missing[2] == '\n' && missing[3] == 0x1F600,
          "distinct unsupported code points in order");

    const std::string described = pie::describeCodePoints({0x6771, 0x1F600, '\n'});
    check(described == "'" + std::string("\xE6\x9D\xB1") + "' (U+6771), '" + kGrinning + "' (U+1F600), (U+000A)",
          "describeCodePoints");
    check(pie::describeCodePoints({1, 2, 3, 4, 5, 6, 7}).find(", …") != std::string::npos, "describe limit");
    check(std::string(pie::kUnsupportedGlyphsPrefix) == "UNSUPPORTED_GLYPHS: ", "prefix shared with TypeScript");
}

}  // namespace

int main() {
    testGlyphCoverage();
    testJsonEscapes();
    testKeyShadowingAndStructure();
    testCopyAndMalformedBatches();
    testUtf8Utf16();
    testVerificationDuplicates();
    std::printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
