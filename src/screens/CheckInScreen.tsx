import React, { useEffect, useState, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert, StatusBar } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Camera, useCameraDevice } from 'react-native-vision-camera';
import { useTensorflowModel } from 'react-native-fast-tflite';
import { BleManager, Device } from 'react-native-ble-plx';
import { Buffer } from 'buffer';

import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabase';
import { useFaceProcessor, LivenessState } from '../hooks/useFaceProcessor';
import { T } from '../theme/tokens';

type FlowStep = 'IDLE' | 'VERIFY_FACE' | 'CONNECT_BLE' | 'SUCCESS' | 'ALREADY_LOGGED' | 'FAILED';

export default function CheckInScreen({ navigation }: any) {
  const { account } = useAuth();
  const device = useCameraDevice('front');
  const [hasPermission, setHasPermission] = useState(false);
  
  const [step, setStep] = useState<FlowStep>('VERIFY_FACE');
  const [uiLivenessState, setUiLivenessState] = useState<LivenessState>('WAITING');
  const [prompt, setPrompt] = useState('Look straight ahead');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [faceSimilarity, setFaceSimilarity] = useState<number | null>(null);
  
  const bleManagerRef = useRef<BleManager | null>(null);

  // Load TFLite model
  const tfliteModel = useTensorflowModel(require('../../android/app/src/main/assets/mobilefacenet.tflite'));

  useEffect(() => {
    (async () => {
      const status = await Camera.requestCameraPermission();
      setHasPermission(status === 'granted');
    })();
    
    bleManagerRef.current = new BleManager();
    return () => {
      bleManagerRef.current?.destroy();
    };
  }, []);

  const handleLivenessStateChange = useCallback((newState: LivenessState, newPrompt: string) => {
    setUiLivenessState(newState);
    setPrompt(newPrompt);
  }, []);

  const handleFaceMatch = useCallback(async (embedding: number[]) => {
    setUiLivenessState('DONE');
    try {
      const { data, error } = await supabase.rpc('platform_verify_face', {
        p_token: account?.token,
        p_embedding: JSON.stringify(embedding),
      });

      if (error) throw new Error(error.message);

      const res = data as any;
      if (!res.match) {
        throw new Error(res.error || `Face not recognized (Similarity: ${(res.similarity * 100).toFixed(1)}%)`);
      }

      // Match success
      setFaceSimilarity(res.similarity);
      setStep('CONNECT_BLE');
      startBleScan(res.similarity);
    } catch (e: any) {
      setErrorMsg(e.message);
      setStep('FAILED');
    }
  }, [account]);

  const { frameProcessor } = useFaceProcessor({
    onLivenessChange: handleLivenessStateChange,
    onFaceEmbedding: handleFaceMatch,
    tfliteModel,
  });

  const startBleScan = (similarity: number) => {
    if (!bleManagerRef.current) return;
    
    setPrompt('Scanning for class beacon...');
    
    const timeoutId = setTimeout(() => {
      bleManagerRef.current?.stopDeviceScan();
      setErrorMsg('Timed out waiting for BLE broadcast.');
      setStep('FAILED');
    }, 15000);

    bleManagerRef.current.startDeviceScan(null, { allowDuplicates: false }, async (error, scannedDevice) => {
      if (error) {
        clearTimeout(timeoutId);
        setErrorMsg(error.message);
        setStep('FAILED');
        return;
      }

      if (scannedDevice && scannedDevice.name?.startsWith('AttendESP_') && scannedDevice.manufacturerData) {
        try {
          bleManagerRef.current?.stopDeviceScan();
          clearTimeout(timeoutId);
          setPrompt('Broadcast received! Verifying check-in...');
          
          // Parse manufacturerData
          const buffer = Buffer.from(scannedDevice.manufacturerData, 'base64');
          
          // Byte 0-1 is company ID (should be 0xFF 0xFF for AttendESP_)
          if (buffer.length < 9) throw new Error('Invalid manufacturer data length');
          
          // Byte 2-5: Short Code (UInt32 Big Endian)
          const shortCode = buffer.readUInt32BE(2).toString();
          
          // Byte 6-8: TOTP packed as BCD
          let token = '';
          for (let i = 6; i < 9; i++) {
            const byte = buffer[i];
            const high = (byte >> 4) & 0x0F;
            const low = byte & 0x0F;
            token += high.toString() + low.toString();
          }
          
          const rssi = scannedDevice.rssi || -99;
          
          const { data, error: rpcError } = await supabase.functions.invoke('verify-checkin', {
            body: {
              session_token: account?.token,
              ble_short_code: shortCode,
              ble_token: token,
              rssi: rssi,
              face_similarity: similarity,
            }
          });

          if (rpcError) {
            const serverErr = data?.error || rpcError.message;
            if (serverErr === 'invalid_token') {
              throw new Error('Invalid BLE token. Please move closer to the class device and try again.');
            } else if (serverErr === 'out_of_range') {
              throw new Error('Move closer to the device and try again.');
            }
            throw new Error(serverErr || 'Check-in verification failed');
          }

          if (!data?.ok) {
            throw new Error(data?.error || 'Failed to log attendance');
          }

          if (data.already_logged_today) {
            setStep('ALREADY_LOGGED');
          } else {
            setStep('SUCCESS');
          }

        } catch (err: any) {
          setErrorMsg(err.message);
          setStep('FAILED');
        }
      }
    });
  };

  const retry = () => {
    setStep('VERIFY_FACE');
    setErrorMsg(null);
    setFaceSimilarity(null);
    setUiLivenessState('WAITING');
    setPrompt('Look straight ahead');
  };

  // ── Step indicator for face capture ─────────────────────────────────────
  const steps: LivenessState[] = ['WAITING', 'BLINK', 'TURN_LEFT', 'TURN_RIGHT', 'CAPTURING'];
  const stepIdx = steps.indexOf(uiLivenessState);

  if (!hasPermission) {
    return (
      <SafeAreaView style={styles.center}>
        <Text style={styles.permissionIcon}>📷</Text>
        <Text style={styles.permissionTitle}>Camera Permission Required</Text>
        <Text style={styles.permissionText}>
          Please grant camera access in Settings to check in.
        </Text>
        <TouchableOpacity style={styles.primaryBtn} onPress={() => navigation.goBack()}>
          <Text style={styles.primaryBtnText}>Go Back</Text>
        </TouchableOpacity>
      </SafeAreaView>
    );
  }

  if (step === 'VERIFY_FACE') {
    return (
      <View style={styles.container}>
        <StatusBar barStyle="light-content" backgroundColor="black" />
        {device ? (
          <Camera
            style={StyleSheet.absoluteFill}
            device={device}
            pixelFormat="rgb"
            isActive={uiLivenessState !== 'DONE'}
            frameProcessor={frameProcessor}
          />
        ) : (
          <Text style={{color: 'white'}}>No camera available.</Text>
        )}
        
        {/* Top header */}
        <SafeAreaView edges={['top']} style={styles.topHeader}>
          <TouchableOpacity style={styles.backBtnLight} onPress={() => navigation.goBack()}>
            <Text style={styles.backArrowLight}>←</Text>
          </TouchableOpacity>
          <View style={{ alignItems: 'center' }}>
            <Text style={styles.headerTitleLight}>Face Verification</Text>
            <Text style={styles.headerSubLight}>Step {Math.max(1, stepIdx + 1)} of {steps.length}</Text>
          </View>
          <View style={{ width: 44 }} /> 
        </SafeAreaView>

        {/* Bottom card */}
        <View style={styles.bottomCard}>
          <View style={styles.dots}>
            {steps.map((s, i) => (
              <View key={s} style={[styles.dot, i <= stepIdx && styles.dotActive]} />
            ))}
          </View>
          <Text style={styles.prompt}>{prompt}</Text>
          {uiLivenessState === 'DONE' && (
            <View style={styles.enrollingRow}>
              <ActivityIndicator color={T.colors.primary} />
              <Text style={styles.enrollingText}>Verifying face...</Text>
            </View>
          )}
          {__DEV__ && uiLivenessState !== 'DONE' && (
            <TouchableOpacity
              style={styles.devBypassBtn}
              onPress={() => {
                const mockEmbedding = Array(192).fill(0).map(() => Math.random() * 2 - 1);
                handleFaceMatch(mockEmbedding);
              }}
            >
              <Text style={styles.devBypassText}>[DEV] Bypass Verification</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.center} edges={['top', 'bottom']}>
      <StatusBar barStyle="dark-content" backgroundColor={T.colors.bg} />
      <View style={styles.messageCard}>
        {step === 'CONNECT_BLE' && (
          <>
            <ActivityIndicator size="large" color={T.colors.primary} style={{ marginBottom: T.spacing.md }} />
            <Text style={styles.statusText}>{prompt}</Text>
            <Text style={styles.subText}>Make sure Bluetooth is turned on.</Text>
          </>
        )}
        
        {step === 'SUCCESS' && (
          <>
            <Text style={styles.emoji}>✅</Text>
            <Text style={styles.cardTitle}>Check-In Successful</Text>
            <Text style={styles.cardText}>Your attendance has been securely verified and logged.</Text>
            <TouchableOpacity style={styles.primaryBtn} onPress={() => navigation.goBack()}>
              <Text style={styles.primaryBtnText}>Done</Text>
            </TouchableOpacity>
          </>
        )}

        {step === 'ALREADY_LOGGED' && (
          <>
            <Text style={styles.emoji}>📋</Text>
            <Text style={styles.cardTitle}>Already Checked In</Text>
            <Text style={styles.cardText}>You already checked in for this class today.</Text>
            <TouchableOpacity style={styles.primaryBtn} onPress={() => navigation.goBack()}>
              <Text style={styles.primaryBtnText}>Done</Text>
            </TouchableOpacity>
          </>
        )}

        {step === 'FAILED' && (
          <>
            <Text style={styles.emoji}>❌</Text>
            <Text style={styles.cardTitle}>Verification Failed</Text>
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{errorMsg}</Text>
            </View>
            <TouchableOpacity style={styles.primaryBtn} onPress={retry}>
              <Text style={styles.primaryBtnText}>Try Again</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.outlineBtn} onPress={() => navigation.goBack()}>
              <Text style={styles.outlineBtnText}>Cancel</Text>
            </TouchableOpacity>
          </>
        )}
      </View>
    </SafeAreaView>
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
    marginBottom: T.spacing.lg,
  },
  topHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: T.spacing.md,
    paddingTop: T.spacing.sm,
  },
  backBtnLight: { padding: T.spacing.xs },
  backArrowLight: { fontSize: T.fontSize.xl, color: '#fff', fontWeight: '700' },
  headerTitleLight: {
    color: '#fff',
    fontSize: T.fontSize.lg,
    fontWeight: '700',
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  headerSubLight: {
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
  enrollingText: { color: T.colors.textMuted, fontSize: T.fontSize.sm },
  devBypassBtn: {
    marginTop: T.spacing.md,
    paddingVertical: T.spacing.sm,
    paddingHorizontal: T.spacing.md,
    borderRadius: T.radius.md,
    borderWidth: 1,
    borderColor: T.colors.warning,
    alignItems: 'center',
  },
  devBypassText: { color: T.colors.warning, fontSize: T.fontSize.sm, fontWeight: '600' },
  
  // Status screen styles
  messageCard: {
    backgroundColor: T.colors.surface,
    padding: T.spacing.xl,
    borderRadius: T.radius.xl,
    width: '100%',
    maxWidth: 400,
    alignItems: 'center',
    ...T.shadow.md,
  },
  emoji: { fontSize: 56, marginBottom: T.spacing.md },
  cardTitle: {
    fontSize: T.fontSize.xl,
    fontWeight: '800',
    color: T.colors.text,
    marginBottom: 8,
    textAlign: 'center',
  },
  cardText: {
    fontSize: T.fontSize.base,
    color: T.colors.textSecondary,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: T.spacing.xl,
  },
  statusText: { fontSize: T.fontSize.lg, fontWeight: '700', color: T.colors.text, textAlign: 'center' },
  subText: { fontSize: T.fontSize.sm, color: T.colors.textSecondary, textAlign: 'center', marginTop: 8 },
  errorBox: {
    backgroundColor: T.colors.errorBg,
    borderRadius: T.radius.md,
    padding: T.spacing.md,
    borderWidth: 1,
    borderColor: '#fecdd3',
    marginBottom: T.spacing.xl,
    width: '100%',
  },
  errorText: { color: T.colors.error, fontSize: T.fontSize.sm, textAlign: 'center' },
  primaryBtn: {
    backgroundColor: T.colors.primary,
    borderRadius: T.radius.md,
    paddingVertical: T.spacing.md,
    paddingHorizontal: T.spacing.xl,
    width: '100%',
    alignItems: 'center',
    ...T.shadow.sm,
  },
  primaryBtnText: { color: '#fff', fontSize: T.fontSize.base, fontWeight: '700' },
  outlineBtn: {
    marginTop: T.spacing.sm,
    paddingVertical: T.spacing.md,
    width: '100%',
    alignItems: 'center',
  },
  outlineBtnText: { color: T.colors.textSecondary, fontSize: T.fontSize.base, fontWeight: '600' },
});
