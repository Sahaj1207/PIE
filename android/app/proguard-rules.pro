# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:

# --- PIE ------------------------------------------------------------------------------
# R8 is currently off (enableProguardInReleaseBuilds = false). These rules make enabling it
# safe: JNI entry points are bound by name (Java_com_pdfimageeditor_...), and JavaScript calls
# native module methods (@ReactMethod) and module names by string.
-keepclasseswithmembernames,includedescriptorclasses class * {
    native <methods>;
}
-keep class com.pdfimageeditor.pdf.NativePdfiumBridge { *; }
-keep class com.pdfimageeditor.** extends com.facebook.react.bridge.ReactContextBaseJavaModule { *; }
-keep class com.pdfimageeditor.** implements com.facebook.react.ReactPackage { *; }
-keepclassmembers class * {
    @com.facebook.react.bridge.ReactMethod <methods>;
}
# Google ML Kit text recognition (bundled model) uses reflection internally.
-keep class com.google.mlkit.** { *; }
-dontwarn com.google.mlkit.**
