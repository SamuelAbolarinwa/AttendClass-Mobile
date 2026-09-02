import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  StatusBar,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Camera, useCameraDevice, useCameraPermission, usePhotoOutput } from 'react-native-vision-camera';
import { useTensorflowModel } from 'react-native-fast-tflite';
import { useImageFaceDetector } from 'react-native-vision-camera-face-detector';
import { Images } from 'react-native-nitro-image';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { T } from '../theme/tokens';

type InitState = 'REQUESTING_PERMISSION' | 'WAITING_FOR_CAMERA' | 'LOADING_TFLITE_MODEL' | 'LOOKING_FOR_FACE' | 'ERROR';

export default function EnrollFaceScreen() {
  const { account, setHasMobileEnrollment } = useAuth();
  const device = useCameraDevice('front');
  const cameraRef = useRef<any>(null);
  const photoOutput = usePhotoOutput({ qualityPrioritization: 'speed' });
  const faceDetector = useImageFaceDetector({
    performanceMode: 'accurate',
    runLandmarks: false,
    runContours: false,
    runClassifications: false,
  });

  const [initState, setInitState] = useState<InitState>('REQUESTING_PERMISSION');
  const [initError, setInitError] = useState<string | null>(null);
  
  const [enrolling, setEnrolling] = useState(false);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [captureStep, setCaptureStep] = useState(0); // 0 = idle, 1..3 = capturing
  const [prompt, setPrompt] = useState('Position your face in the frame');

  const { requestPermission, hasPermission } = useCameraPermission();
  const tfliteModel = useTensorflowModel(require('../../android/app/src/main/assets/mobilefacenet.tflite'), []);

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>;
    if (initState === 'REQUESTING_PERMISSION') {
      if (hasPermission) {
        setInitState('WAITING_FOR_CAMERA');
        return;
      }
      timeout = setTimeout(() => {
        setInitState('ERROR');
        setInitError('Timed out requesting camera permission.');
      }, 10000);
      requestPermission().then(status => {
        if (!status) {
          setInitState('ERROR');
          setInitError('Camera permission denied.');
        } else {
          setInitState('WAITING_FOR_CAMERA');
        }
      }).catch(e => {
        setInitState('ERROR');
        setInitError(e.message);
      });
      return () => clearTimeout(timeout);
    }
  }, [initState, requestPermission, hasPermission]);

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>;
    if (initState === 'WAITING_FOR_CAMERA') {
      timeout = setTimeout(() => {
        setInitState('ERROR');
        setInitError('Timed out waiting for camera to initialize.');
      }, 10000);
      if (device) {
        setInitState('LOADING_TFLITE_MODEL');
      }
      return () => clearTimeout(timeout);
    }
  }, [initState, device]);

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>;
    if (initState === 'LOADING_TFLITE_MODEL') {
      timeout = setTimeout(() => {
        setInitState('ERROR');
        setInitError('Timed out loading TFLite model.');
      }, 10000);
      
      if (tfliteModel.state === 'loaded' && tfliteModel.model) {
        setInitState('LOOKING_FOR_FACE');
      } else if (tfliteModel.state === 'error') {
        setInitState('ERROR');
        // @ts-ignore
        setInitError(tfliteModel.error?.message || 'Failed to load model.');
      }
      return () => clearTimeout(timeout);
    }
  }, [initState, tfliteModel.state, tfliteModel.model, (tfliteModel as any).error]);

  const submitEmbeddings = async (embeddings: number[][]) => {
    try {
      // Average the embeddings
      const averaged = Array(192).fill(0);
      for (let i = 0; i < 192; i++) {
        let sum = 0;
        for (let j = 0; j < embeddings.length; j++) {
          sum += embeddings[j][i];
        }
        averaged[i] = sum / embeddings.length;
      }

      const { data, error } = await supabase.rpc('platform_enroll_face', {
        p_token: account?.token,
        p_embedding: JSON.stringify(averaged),
        p_model_version: 'mobilefacenet-mobile-v1',
      });
      if (error || !(data as any).ok) {
        throw new Error(error?.message || 'Could not save face data.');
      }
      
      Alert.alert('Face Enrolled', 'Your face has been registered. You can now check in.', [
        { text: 'Continue', onPress: () => setHasMobileEnrollment(true) },
      ]);
    } catch (e: any) {
      setEnrollError(e.message);
      setCaptureStep(0);
      setPrompt('Position your face in the frame');
    }
  };

  const startCaptureSequence = async () => {
    if (!cameraRef.current) return;
    if (!tfliteModel.model) {
      setEnrollError("Model not loaded yet.");
      return;
    }
    
    setEnrolling(true);
    setEnrollError(null);
    const embeddings: number[][] = [];
    
    try {
      for (let step = 1; step <= 3; step++) {
        setCaptureStep(step);
        setPrompt(`Capturing photo ${step} of 3...`);
        
        const photo = await photoOutput.capturePhoto({}, {});
        const photoPath = await photo.saveToTemporaryFileAsync();
        const faces = faceDetector.detectFaces({ uri: 'file://' + photoPath });
        
        if (faces.length !== 1) {
            throw new Error(`Expected exactly 1 face, found ${faces.length}. Please retry.`);
        }
        
        const face = faces[0];
        const image = await Images.loadFromFileAsync(photoPath);
        
        const startX = Math.max(0, face.bounds.x);
        const startY = Math.max(0, face.bounds.y);
        const endX = Math.min(image.width, face.bounds.x + face.bounds.width);
        const endY = Math.min(image.height, face.bounds.y + face.bounds.height);
        
        const cropped = image.crop(startX, startY, endX, endY);
        const resized = cropped.resize(112, 112);
        
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
            r = rgba[i]; g = rgba[i + 1]; b = rgba[i + 2];
          }
          rgbFloat[j++] = ((r / 255.0) - 0.5) * 2.0;
          rgbFloat[j++] = ((g / 255.0) - 0.5) * 2.0;
          rgbFloat[j++] = ((b / 255.0) - 0.5) * 2.0;
        }

        const outputBuffers = await tfliteModel.model.run([rgbFloat.buffer]);
        const embeddingArray = Array.from(new Float32Array(outputBuffers[0]));
        embeddings.push(embeddingArray);
        
        photo.dispose();
        
        // Wait 1 second before next shot
        if (step < 3) {
            await new Promise(res => setTimeout(() => res(null), 1000));
        }
      }
      
      setPrompt('Saving face data...');
      await submitEmbeddings(embeddings);
      
    } catch (e: any) {
      setEnrollError(e.message + (e.stack ? '\n' + e.stack : ''));
      setCaptureStep(0);
      setPrompt('Position your face in the frame');
    } finally {
      setEnrolling(false);
    }
  };

  if (initState === 'ERROR') {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.permissionIcon}>❌</Text>
        <Text style={styles.permissionTitle}>Initialization Failed</Text>
        <Text style={styles.permissionText}>{initError}</Text>
        <TouchableOpacity style={styles.outlineBtn} onPress={() => { setInitState('REQUESTING_PERMISSION'); setInitError(null); }}>
          <Text style={styles.outlineBtnText}>Retry</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  if (initState !== 'LOOKING_FOR_FACE') {
    return (
      <SafeAreaView style={styles.center}>
        <ActivityIndicator size="large" color={T.colors.primary} />
        <Text style={[styles.permissionTitle, { marginTop: 20 }]}>{initState.replace(/_/g, ' ')}</Text>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="black" />
      {device && (
        <Camera
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          device={device}
          isActive={true}
          outputs={[photoOutput]}
        />
      )}

      <SafeAreaView edges={['top']} style={styles.topHeader}>
        <Text style={styles.headerTitle}>Face Enrollment</Text>
        <Text style={styles.headerSub}>Static Capture Mode</Text>
      </SafeAreaView>

      {/* Bottom card */}
      <View style={styles.bottomCard}>
        {/* Progress dots */}
        <View style={styles.dots}>
          {[1, 2, 3].map((s) => (
            <View
              key={s}
              style={[styles.dot, captureStep >= s && styles.dotActive]}
            />
          ))}
        </View>

        <Text style={styles.prompt}>{prompt}</Text>
        
        {enrollError && (
          <Text style={styles.errorText}>{enrollError}</Text>
        )}

        {enrolling ? (
          <View style={styles.enrollingRow}>
            <ActivityIndicator color={T.colors.primary} />
            <Text style={styles.enrollingText}>Processing...</Text>
          </View>
        ) : (
          <TouchableOpacity style={styles.captureBtn} onPress={startCaptureSequence}>
            <Text style={styles.captureBtnText}>Start Capture</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'black',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: T.colors.bg,
    padding: T.spacing.lg,
  },
  permissionIcon: {
    fontSize: 48,
    marginBottom: T.spacing.md,
  },
  permissionTitle: {
    fontSize: T.fontSize.xl,
    fontWeight: '700',
    color: T.colors.text,
    textAlign: 'center',
    marginBottom: 8,
  },
  permissionText: {
    fontSize: T.fontSize.sm,
    color: T.colors.textSecondary,
    textAlign: 'center',
    lineHeight: 20,
  },
  topHeader: {
    alignItems: 'center',
    paddingTop: T.spacing.sm,
  },
  headerTitle: {
    color: '#fff',
    fontSize: T.fontSize.lg,
    fontWeight: '700',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  headerSub: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: T.fontSize.xs,
    marginTop: 2,
  },
  bottomCard: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(15,23,42,0.88)',
    padding: T.spacing.lg,
    paddingBottom: T.spacing.xxl,
    borderTopLeftRadius: T.radius.xl,
    borderTopRightRadius: T.radius.xl,
  },
  dots: {
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'center',
    marginBottom: T.spacing.md,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: T.radius.full,
    backgroundColor: 'rgba(255,255,255,0.25)',
  },
  dotActive: {
    backgroundColor: T.colors.primary,
    width: 20,
  },
  prompt: {
    color: '#fff',
    fontSize: T.fontSize.xl,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: T.spacing.md,
  },
  enrollingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: T.spacing.sm,
  },
  enrollingText: {
    color: T.colors.textMuted,
    fontSize: T.fontSize.sm,
  },
  errorText: {
    color: T.colors.error,
    fontSize: T.fontSize.sm,
    textAlign: 'center',
    marginBottom: T.spacing.md,
  },
  captureBtn: {
    backgroundColor: T.colors.primary,
    paddingVertical: T.spacing.md,
    paddingHorizontal: T.spacing.xl,
    borderRadius: T.radius.lg,
    alignItems: 'center',
    width: '100%',
  },
  captureBtnText: {
    color: '#fff',
    fontSize: T.fontSize.base,
    fontWeight: '700',
  },
  outlineBtn: {
    marginTop: T.spacing.sm,
    paddingVertical: T.spacing.md,
    width: '100%',
    alignItems: 'center',
  },
  outlineBtnText: {
    color: T.colors.textSecondary,
    fontSize: T.fontSize.base,
    fontWeight: '600',
  },
});
