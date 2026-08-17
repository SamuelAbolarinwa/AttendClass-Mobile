import React, { useEffect, useState, useCallback } from 'react';
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
import { Camera, useCameraDevice } from 'react-native-vision-camera';
import { useTensorflowModel } from 'react-native-fast-tflite';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { useFaceProcessor, LivenessState } from '../hooks/useFaceProcessor';
import { T } from '../theme/tokens';

export default function EnrollFaceScreen() {
  const { account, setHasMobileEnrollment } = useAuth();
  const device = useCameraDevice('front');
  const [hasPermission, setHasPermission] = useState(false);
  const [uiLivenessState, setUiLivenessState] = useState<LivenessState>('WAITING');
  const [prompt, setPrompt] = useState('Look straight ahead');
  const [enrolling, setEnrolling] = useState(false);

  const tfliteModel = useTensorflowModel(require('../../android/app/src/main/assets/mobilefacenet.tflite'), ['default']);

  useEffect(() => {
    (async () => {
      const status = await Camera.requestCameraPermission();
      setHasPermission(status === 'granted');
    })();
  }, []);

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

  const { frameOutput } = useFaceProcessor({
    onLivenessChange: handleLivenessStateChange,
    onFaceEmbedding: handleFaceEnrolled,
    tfliteModel,
  });

  // ── Step indicator ────────────────────────────────────────────────────────
  const steps: LivenessState[] = ['WAITING', 'BLINK', 'TURN_LEFT', 'TURN_RIGHT', 'CAPTURING'];
  const stepIdx = steps.indexOf(uiLivenessState);

  if (!hasPermission) {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.permissionIcon}>📷</Text>
        <Text style={styles.permissionTitle}>Camera Permission Required</Text>
        <Text style={styles.permissionText}>
          Please grant camera access in Settings to enroll your face.
        </Text>
      </SafeAreaView>
    );
  }

  if (!device) {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.permissionIcon}>🔍</Text>
        <Text style={styles.permissionTitle}>No Front Camera</Text>
        <Text style={styles.permissionText}>A front-facing camera is required.</Text>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="black" />
      <Camera
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={!enrolling && uiLivenessState !== 'DONE'}
        outputs={[frameOutput]}
      />

      {/* Top header */}
      <SafeAreaView edges={['top']} style={styles.topHeader}>
        <Text style={styles.headerTitle}>Face Enrollment</Text>
        <Text style={styles.headerSub}>Step {Math.max(1, stepIdx + 1)} of {steps.length}</Text>
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
