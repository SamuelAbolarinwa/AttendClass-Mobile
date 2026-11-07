# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in /usr/local/Cellar/android-sdk/24.3.3/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:

# Keep VisionCamera classes
-keep class com.mrousavy.camera.** { *; }

# Keep Nitro Modules and Native Methods
-keep class com.margelo.nitro.** { *; }
-keep class com.margelo.nitro.core.** { *; }
-keepclassmembers class * {
    @com.margelo.nitro.core.NativeMethod <methods>;
}

# Keep Fast TFLite
-keep class com.margelo.tflite.** { *; }

# Ensure native JNI methods and @Keep/@DoNotStrip are not stripped
-keepclasseswithmembernames class * {
    native <methods>;
}
-keep @androidx.annotation.Keep class * { *; }
-keep class * {
    @androidx.annotation.Keep <fields>;
}
-keep class * {
    @androidx.annotation.Keep <methods>;
}
-keep @com.facebook.proguard.annotations.DoNotStrip class *
-keepclassmembers class * {
    @com.facebook.proguard.annotations.DoNotStrip *;
}

# Keep ML Kit Barcode Scanning & Custom BarcodeScanner Module
-keep class com.google.mlkit.vision.barcode.** { *; }
-keep class com.mobileapp.barcodescanner.** { *; }
