\# PIE — PDF \& Image Editor



\## Project



PIE is an offline-first PDF and Image Editor built with React Native for Android and iOS.



Canonical project:

`D:\\PDFImageEditor`



GitHub:

`Sahaj1207/PIE`



\## Critical Rule



This project was developed incrementally through Phase 9.



DO NOT rewrite the architecture.

DO NOT replace working systems without first auditing them.

DO NOT copy anything from the legacy project:



`D:\\PDF \& Image Editor`



The legacy project is not the source of truth.



The current PIE repository is the source of truth.



\---



\# Technology



\- React Native 0.87.1

\- React 19

\- TypeScript strict

\- Hermes

\- React Native New Architecture

\- React Native Reanimated

\- React Native Gesture Handler

\- react-native-worklets

\- @shopify/react-native-skia

\- React Navigation 7



Native:



Android:

\- Kotlin

\- C++

\- PDFium

\- Google ML Kit on-device OCR



iOS:

\- Swift / Objective-C

\- Apple Vision OCR



The application is designed to work offline.



\---



\# Product Requirements



PIE must support:



\## PDF



\- Import PDF

\- Render PDF

\- Zoom

\- Pan

\- Select existing text

\- Edit existing text

\- Delete existing text

\- Add text

\- Text formatting

\- Nested Form XObject handling

\- Undo / redo

\- Save

\- Save As

\- Reopen

\- Source immutability

\- Reliable lifecycle handling



\## Images



\- Import images

\- Display original image dimensions

\- Zoom

\- Pan

\- OCR

\- Select detected text

\- Edit detected text

\- Replace detected text

\- Delete detected text

\- Deterministic background reconstruction

\- Multiple replacements

\- Undo / redo

\- Export preparation



\## Privacy



Core processing must remain on-device.



Do NOT introduce:



\- cloud uploads

\- mandatory accounts

\- subscriptions

\- collaboration

\- cloud document storage

\- remote OCR

\- generative AI image editing



\---



\# Completed Phases



\## Phase 1

Foundation and import/rendering.



\## Phase 2

Coordinate system and gesture foundation.



\## Phase 3

PDF document extraction, object identity, selection and hit testing.



\## Phase 4A

PDF existing-text replacement.



\## Phase 4B

PDF existing-text deletion.



\## Phase 4C

PDF Add Text.



\## Phase 4D

PDF save/reopen/persistence hardening.



\## Phase 5

PDF formatting and layout fidelity.



\## Phase 6

PDF lifecycle, Save/Save As and navigation hardening.



\## Phase 7

Image editor foundation:

\- image import

\- rendering

\- intrinsic dimensions

\- orientation

\- viewport

\- zoom

\- pan

\- coordinate mapping



\## Phase 8

On-device OCR:

\- Android ML Kit

\- iOS Vision

\- OCR normalization

\- OCR boxes

\- OCR hit testing

\- OCR selection

\- OCR caching



\## Phase 9

Image text editing:

\- OCR selection integration

\- image text editing modal

\- replacement model

\- style estimation

\- font fallback

\- text fitting

\- deterministic background reconstruction

\- patch/layer model

\- replacement preview

\- replacement application

\- text deletion

\- multiple replacements

\- undo/redo

\- dirty state

\- export preparation

\- error handling



Latest Phase 9 automated result:



549 tests passed after removal of obsolete Nutrient spike tests.



TypeScript passed.



\---



\# Current Verification Status



Automated tests:

PASS



TypeScript:

PASS



Android build:

Previously verified through Phase 9 implementation.



Android runtime:

Previously verified through Phase 8 baseline.



Physical image editing:

NOT YET VERIFIED.



Important:



Do NOT claim that the complete image editing workflow is physically working merely because automated tests pass.



Physical QA will be performed separately after the integrated product is ready.



\---



\# Architecture Rules



\## Coordinate Systems



Document coordinates are the source of truth.



Do not persist screen coordinates.



Viewport transformations must be centralized.



Zoom and pan must not alter document-space data.



\## Source Immutability



Original PDFs and images must never be destructively modified.



Edits must operate on:



\- working copies

\- reversible patches

\- editing layers

\- or equivalent safe representations



\## PDF



PDFium is the PDF engine.



Do not replace PDFium with another PDF engine without explicit approval.



\## Image



Skia is the primary rendering layer.



Do not create a second rendering system.



\## OCR



Android:

Google ML Kit, on-device.



iOS:

Apple Vision.



Do not add cloud OCR.



\## Editing



Image text edits should use deterministic local processing.



Do not introduce generative AI or cloud image processing.



\---



\# Testing Rules



Every feature phase must include:



1\. Implementation

2\. Automated tests

3\. TypeScript validation

4\. Android bundle/build

5\. Installation when device is available

6\. Runtime verification



Reports must distinguish:



\- IMPLEMENTED IN CODE

\- AUTOMATED TESTED

\- RUNTIME VERIFIED

\- PHYSICALLY VERIFIED

\- NOT VERIFIED

\- BLOCKED



Never equate compilation/tests with physical feature verification.



Do not remove existing regression tests simply to make a new feature pass.



\---



\# Code Change Rules



Before making major architectural changes:



1\. Inspect the existing implementation.

2\. Identify what can be reused.

3\. Explain what will change.

4\. Preserve existing functionality.

5\. Add regression tests.

6\. Run the full test suite.



Do not create duplicate:



\- coordinate systems

\- history systems

\- selection systems

\- rendering systems

\- document models

\- OCR models



Reuse existing infrastructure whenever possible.



\---



\# Legacy Project



Never use:



`D:\\PDF \& Image Editor`



It is an old project and is NOT the source of truth.



Only use:



`D:\\PDFImageEditor`



\---



\# Current Next Phase



The next planned phase is:



\## Phase 10 — Image Export + Persistence + Save/Reopen



Before implementing it:



\- audit the existing image editing architecture

\- inspect existing export infrastructure

\- inspect image document session

\- inspect patch/layer representation

\- inspect dirty state

\- inspect storage

\- inspect lifecycle handling



Do not immediately rewrite anything.



\---



\# Final Product Goal



PIE should become a polished, production-ready offline-first PDF and Image Editor.



Prioritize:



\- reliability

\- correctness

\- native-feeling interaction

\- performance

\- source immutability

\- deterministic behavior

\- privacy

\- maintainable architecture



Do not add unrelated features.



Do not optimize for feature count.



Do not rewrite working code merely for stylistic preference.

