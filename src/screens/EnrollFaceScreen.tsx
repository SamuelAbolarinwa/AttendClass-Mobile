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
import { Camera, useCameraDevice, useCameraPermission } from 'react-native-vision-camera';
import { useTensorflowModel } from 'react-native-fast-tflite';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { useFaceProcessor, LivenessState } from '../hooks/useFaceProcessor';
import { T } from '../theme/tokens';

type InitState = 'REQUESTING_PERMISSION' | 'WAITING_FOR_CAMERA' | 'LOADING_TFLITE_MODEL' | 'LOOKING_FOR_FACE' | 'ERROR';

export default function EnrollFaceScreen() {
  const { account, setHasMobileEnrollment } = useAuth();
  const device = useCameraDevice('front');
  const [uiLivenessState, setUiLivenessState] = useState<LivenessState>('WAITING');
  const [prompt, setPrompt] = useState('Look straight ahead');
  const [enrolling, setEnrolling] = useState(false);

  const [initState, setInitState] = useState<InitState>('REQUESTING_PERMISSION');
  const [initError, setInitError] = useState<string | null>(null);
  const [frameCount, setFrameCount] = useState(0);

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

  const handleLivenessStateChange = useCallback((newState: LivenessState, newPrompt: string) => {
    setUiLivenessState(newState);
    setPrompt(newPrompt);
  }, []);

  const handleFaceEnrolled = useCallback(async (embedding: number[]) => {
    setEnrolling(true);
    setUiLivenessState('DONE');
    try {
      const { data, error } = await supabase.rpc('platform_enroll_face', {
        p_token: account?.token,
        p_embedding: JSON.stringify(embedding),
        p_model_version: 'mobilefacenet-mobile-v1',
      });
      if (error || !(data as any).ok) {
        Alert.alert('Enrollment Failed', error?.message || 'Could not save face data. Please try again.');
        setUiLivenessState('WAITING');
        setPrompt('Look straight ahead');
      } else {
        Alert.alert('Face Enrolled', 'Your face has been registered. You can now check in.', [
          { text: 'Continue', onPress: () => setHasMobileEnrollment(true) },
        ]);
      }
    } catch (e: any) {
      Alert.alert('Error', e.message);
      setUiLivenessState('WAITING');
      setPrompt('Look straight ahead');
    } finally {
      setEnrolling(false);
    }
  }, [account, setHasMobileEnrollment]);

  const lastTickRef = useRef(0);
  const handleFrameTick = useCallback(() => {
    const now = Date.now();
    if (now - lastTickRef.current > 500) {
      setFrameCount(prev => prev + 1);
      lastTickRef.current = now;
    }
  }, []);

  const { frameOutput } = useFaceProcessor({
    onLivenessChange: handleLivenessStateChange,
    onFaceEmbedding: handleFaceEnrolled,
    onFrameTick: handleFrameTick,
    tfliteModel,
  });

  // ── Step indicator ────────────────────────────────────────────────────────
  const steps: LivenessState[] = ['WAITING', 'BLINK', 'TURN_LEFT', 'TURN_RIGHT', 'CAPTURING'];
  const stepIdx = steps.indexOf(uiLivenessState);

  if (initState === 'ERROR') {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.permissionIcon}>❌</Text>
        <Text style={styles.permissionTitle}>Initialization Failed</Text>
        <Text style={styles.permissionText}>{initError}</Text>
        <TouchableOpacity style={styles.devBypassBtn} onPress={() => { setInitState('REQUESTING_PERMISSION'); setInitError(null); }}>
          <Text style={styles.devBypassText}>Retry</Text>
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
          style={StyleSheet.absoluteFill}
          device={device}
          isActive={!enrolling && uiLivenessState !== 'DONE'}
          outputs={[frameOutput]}
        />
      )}

      <SafeAreaView edges={['top']} style={styles.topHeader}>
        <Text style={styles.headerTitle}>Face Enrollment</Text>
        <Text style={styles.headerSub}>Step {Math.max(1, stepIdx + 1)} of {steps.length} | Frames: {frameCount}</Text>
      </SafeAreaView>

      {/* Bottom card */}
      <View style={styles.bottomCard}>
        {/* Progress dots */}
        <View style={styles.dots}>
          {steps.map((s, i) => (
            <View
              key={s}
              style={[styles.dot, i <= stepIdx && styles.dotActive]}
            />
          ))}
        </View>

        <Text style={styles.prompt}>{prompt}</Text>

        {enrolling && (
          <View style={styles.enrollingRow}>
            <ActivityIndicator color={T.colors.primary} />
            <Text style={styles.enrollingText}>Saving face data…</Text>
          </View>
        )}

        {__DEV__ && uiLivenessState !== 'DONE' && !enrolling && (
          <TouchableOpacity
            style={styles.devBypassBtn}
            onPress={() => {
              const mock = Array(192).fill(0).map(() => Math.random() * 2 - 1);
              handleFaceEnrolled(mock);
            }}
          >
            <Text style={styles.devBypassText}>[DEV] Bypass Liveness</Text>
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
  devBypassBtn: {
    marginTop: T.spacing.md,
    paddingVertical: T.spacing.sm,
    paddingHorizontal: T.spacing.md,
    borderRadius: T.radius.md,
    borderWidth: 1,
    borderColor: T.colors.warning,
    alignItems: 'center',
  },
  devBypassText: {
    color: T.colors.warning,
    fontSize: T.fontSize.sm,
    fontWeight: '600',
  },
});
