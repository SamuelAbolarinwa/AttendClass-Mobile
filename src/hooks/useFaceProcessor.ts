import { useMemo, useRef } from 'react';
import { useSharedValue } from 'react-native-reanimated';
import { runOnJS } from 'react-native-worklets';
import { useFrameOutput } from 'react-native-vision-camera';
import { useFaceDetector } from 'react-native-vision-camera-face-detector';
import { Images } from 'react-native-nitro-image';

export type LivenessState = 'WAITING' | 'BLINK' | 'TURN_LEFT' | 'TURN_RIGHT' | 'CAPTURING' | 'DONE';

interface UseFaceProcessorOptions {
  onLivenessChange: (state: LivenessState, prompt: string) => void;
  onFaceEmbedding: (embedding: number[]) => void;
  onFrameTick?: () => void;
  onDebugChange?: (debugData: any) => void;
  onError?: (error: string) => void;
  tfliteModel: any;
}

export function useFaceProcessor({ onLivenessChange, onFaceEmbedding, onFrameTick, onDebugChange, onError, tfliteModel }: UseFaceProcessorOptions) {
  const livenessState = useSharedValue<LivenessState>('WAITING');
  const frameCount = useSharedValue(0);

  // ── CRITICAL FIX 1: Stabilise Worklets.createRunOnJS handles ──────────────
  // These must NOT be recreated on every render — they hold native worklet state.
  // Wrap callbacks in refs first so the memos are stable across re-renders while
  // still calling the latest version of the callback.
  const onLivenessRef = useRef(onLivenessChange);
  onLivenessRef.current = onLivenessChange;
  const onEmbeddingRef = useRef(onFaceEmbedding);
  onEmbeddingRef.current = onFaceEmbedding;
  const onFrameTickRef = useRef(onFrameTick);
  onFrameTickRef.current = onFrameTick;
  const onDebugRef = useRef(onDebugChange);
  onDebugRef.current = onDebugChange;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const jsHandleLiveness = useMemo(
    () => runOnJS((state: LivenessState, prompt: string) => onLivenessRef.current(state, prompt)),
    [], // Created once, never recreated
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const jsHandleFaceEnrolled = useMemo(
    () => runOnJS((embedding: number[]) => onEmbeddingRef.current(embedding)),
    [],
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const jsHandleFrameTick = useMemo(
    () => runOnJS(() => {
      if (onFrameTickRef.current) onFrameTickRef.current();
    }),
    [],
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const jsHandleDebug = useMemo(
    () => runOnJS((debugData: any) => {
      if (onDebugRef.current) onDebugRef.current(debugData);
    }),
    [],
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const jsHandleError = useMemo(
    () => runOnJS((err: string) => {
      if (onErrorRef.current) onErrorRef.current(err);
    }),
    [],
  );

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const jsHandleSanityCheck = useMemo(
    () => runOnJS((imageObj: any) => {
      if (imageObj && imageObj.saveToTemporaryFileAsync) {
        imageObj.saveToTemporaryFileAsync('jpg', 90)
          .then((path: string) => {
            console.log(`\n\n[FaceCrop Sanity Check] Saved 112x112 face crop to: file://${path}\n\n`);
          })
          .catch((e: any) => console.log('Sanity check save error:', e));
      }
    }),
    [],
  );

  // ── CRITICAL FIX 2: Stabilise face detector ────────────────────────────────
  // useFaceDetector returns a new object on every render because it doesn't
  // memoize internally. We keep a stable ref so useFrameProcessor's dependency
  // array doesn't change on every render, which would cause the frameProcessor
  // to be torn down and recreated in a hot loop.
  const faceDetectorOptions = useMemo(() => ({
    performanceMode: 'fast' as const,
    runLandmarks: true,
    runContours: false,
    runClassifications: true,
  }), []);

  const faceDetector = useFaceDetector(faceDetectorOptions);
  const faceDetectorRef = useRef(faceDetector);
  faceDetectorRef.current = faceDetector;

  // ── CRITICAL FIX 3: Don't put the full tfliteModel object in deps ──────────
  // When the model finishes loading, the tfliteModel object reference changes
  // and would cause the frameProcessor to be recreated mid-session.
  // Use a ref instead — the worklet reads .current synchronously.
  const tfliteRef = useRef(tfliteModel);
  tfliteRef.current = tfliteModel;

  const frameOutput = useFrameOutput({
    pixelFormat: 'rgb',
    onFrame: (frame) => {
      'worklet';

      try {
        frameCount.value = frameCount.value + 1;
        jsHandleFrameTick();
        if (livenessState.value === 'DONE') return;

    const faces = faceDetectorRef.current.detectFaces(frame);
    
    jsHandleDebug({
        frameCount: frameCount.value,
        pixelFormat: frame.pixelFormat,
        width: frame.width,
        height: frame.height,
        facesDetected: faces.length,
        isDone: livenessState.value === 'DONE'
    });

    if (faces.length === 0) {
      if (livenessState.value !== 'WAITING') {
        livenessState.value = 'WAITING';
        jsHandleLiveness('WAITING', 'Face lost. Look straight ahead.');
      }
      return;
    }

    const face = faces[0];
    const { leftEyeOpenProbability = 1, rightEyeOpenProbability = 1, yawAngle } = face;

    if (livenessState.value === 'WAITING') {
      if (leftEyeOpenProbability < 0.2 && rightEyeOpenProbability < 0.2) {
        livenessState.value = 'BLINK';
        jsHandleLiveness('BLINK', 'Blink detected! Now turn your head left.');
      }
    } else if (livenessState.value === 'BLINK') {
      if (yawAngle < -20) {
        livenessState.value = 'TURN_LEFT';
        jsHandleLiveness('TURN_LEFT', 'Great! Now turn your head right.');
      }
    } else if (livenessState.value === 'TURN_LEFT') {
      if (yawAngle > 20) {
        livenessState.value = 'CAPTURING';
        jsHandleLiveness('CAPTURING', 'Perfect! Capturing face...');
      }
    } else if (livenessState.value === 'CAPTURING') {
      if (!tfliteRef.current?.model) {
        livenessState.value = 'WAITING';
        jsHandleLiveness('WAITING', 'Error: TFLite model is not loaded yet.');
        return;
      }

      try {
        livenessState.value = 'DONE'; // Prevent multiple captures

        // 1. Convert Frame to ArrayBuffer
        const buffer = frame.getPixelBuffer();

        // Map Vision-Camera v4 pixel format strings to Nitro-Image formats.
        // When Camera prop pixelFormat="rgb", Android delivers 'rgb-bgra-8-bit'.
        let nitroPixelFormat: 'RGBA' | 'BGRA' | 'ARGB' | 'RGB' | 'unknown' = 'unknown';
        const fp = frame.pixelFormat; // e.g. "rgb-bgra-8-bit", "rgb-rgba-8-bit", "rgb-rgb-8-bit"
        if (fp === 'rgb-bgra-8-bit') {
          nitroPixelFormat = 'BGRA';
        } else if (fp === 'rgb-rgba-8-bit') {
          nitroPixelFormat = 'RGBA';
        } else if (fp === 'rgb-rgb-8-bit') {
          nitroPixelFormat = 'RGB';
        } else if (fp.includes('bgra')) {
          nitroPixelFormat = 'BGRA';
        } else if (fp.includes('rgba')) {
          nitroPixelFormat = 'RGBA';
        } else if (fp.includes('argb')) {
          nitroPixelFormat = 'ARGB';
        } else if (fp.includes('rgb')) {
          nitroPixelFormat = 'RGB';
        }

        // 2. Load into Nitro Image
        const image = Images.loadFromRawPixelData({
          buffer: buffer,
          width: frame.width,
          height: frame.height,
          pixelFormat: nitroPixelFormat,
        });

        // 3. Crop to face bounds (clamped to frame dimensions)
        const bounds = face.bounds;
        const startX = Math.max(0, bounds.x);
        const startY = Math.max(0, bounds.y);
        const endX = Math.min(frame.width, bounds.x + bounds.width);
        const endY = Math.min(frame.height, bounds.y + bounds.height);

        const cropped = image.crop(startX, startY, endX, endY);

        // 4. Resize to 112x112 for MobileFaceNet
        const resized = cropped.resize(112, 112);

        // Sanity Check: send to JS thread to save and log in __DEV__
        jsHandleSanityCheck(resized);

        // 5. Get raw bytes and convert to Float32 (-1 to 1 normalised RGB)
        const outputData = resized.toRawPixelData();
        const rgba = new Uint8Array(outputData.buffer);
        const rgbFloat = new Float32Array(112 * 112 * 3);

        const isBGRA = outputData.pixelFormat === 'BGRA' || (outputData.pixelFormat as any) === 'bgra';
        const isARGB = outputData.pixelFormat === 'ARGB' || (outputData.pixelFormat as any) === 'argb';

        let j = 0;
        for (let i = 0; i < rgba.length; i += 4) {
          let r: number, g: number, b: number;
          if (isBGRA) {
            b = rgba[i]; g = rgba[i + 1]; r = rgba[i + 2];
          } else if (isARGB) {
            r = rgba[i + 1]; g = rgba[i + 2]; b = rgba[i + 3];
          } else {
            // RGBA (default)
            r = rgba[i]; g = rgba[i + 1]; b = rgba[i + 2];
          }
          rgbFloat[j++] = ((r / 255.0) - 0.5) * 2.0;
          rgbFloat[j++] = ((g / 255.0) - 0.5) * 2.0;
          rgbFloat[j++] = ((b / 255.0) - 0.5) * 2.0;
        }

        // 6. Run TFLite inference
        const outputBuffers = tfliteRef.current.model.runSync([rgbFloat.buffer]);
        const embeddingBuffer = outputBuffers[0];
        const embeddingArray = Array.from(new Float32Array(embeddingBuffer));

        // 7. Pass back to JS thread
        jsHandleFaceEnrolled(embeddingArray);

      } catch (e: any) {
        livenessState.value = 'WAITING';
        jsHandleLiveness('WAITING', `Error: ${e.message ?? 'Unknown'}. Tap retry.`);
      }
    }
      } catch (globalError: any) {
        jsHandleError(globalError.message || String(globalError));
      } finally {
        frame.dispose();
      }
    }
  });

  return { frameOutput, livenessState };
}
