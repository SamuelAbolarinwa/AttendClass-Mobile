package com.mobileapp.barcodescanner

import android.net.Uri
import com.facebook.react.bridge.*
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.io.File

class BarcodeScannerModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    override fun getName(): String = "BarcodeScanner"

    private val options = BarcodeScannerOptions.Builder()
        .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
        .build()

    private val scanner = BarcodeScanning.getClient(options)

    @ReactMethod
    fun scanFromUri(uriString: String, promise: Promise) {
        try {
            val uri = Uri.parse(uriString)
            if (uri.scheme == "file") {
                val file = File(uri.path ?: "")
                if (!file.exists()) {
                    promise.resolve(Arguments.createArray())
                    return
                }
            }

            val image = InputImage.fromFilePath(reactContext, uri)
            scanner.process(image)
                .addOnSuccessListener { barcodes ->
                    val array = Arguments.createArray()
                    for (barcode in barcodes) {
                        barcode.rawValue?.let { array.pushString(it) }
                    }
                    promise.resolve(array)
                }
                .addOnFailureListener {
                    promise.resolve(Arguments.createArray())
                }
        } catch (e: Exception) {
            promise.resolve(Arguments.createArray())
        }
    }
}
