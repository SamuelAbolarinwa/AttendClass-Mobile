import React, { useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  StatusBar,
  Dimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useObjectOutput,
} from 'react-native-vision-camera';
import { useIsFocused } from '@react-navigation/native';
import { QRValidator } from '../qr/QRValidator';
import { T } from '../theme/tokens';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const VIEWFINDER_SIZE = Math.min(SCREEN_WIDTH * 0.72, 280);

export default function QRScannerScreen({ navigation }: any) {
  const isFocused = useIsFocused();
  const device = useCameraDevice('back');
  const { hasPermission, requestPermission } = useCameraPermission();

  const [torch, setTorch] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const lastScannedTimeRef = useRef(0);

  const handleScannedText = useCallback(
    (rawText: string) => {
      const now = Date.now();
      // Debounce: prevent duplicate scan processing within 2.5 seconds
      if (now - lastScannedTimeRef.current < 2500 || isProcessing) {
        return;
      }
      lastScannedTimeRef.current = now;

      setErrorBanner(null);
      const validation = QRValidator.validate(rawText, true);

      if (!validation.valid) {
        setErrorBanner(validation.errorMessage);
        return;
      }

      setIsProcessing(true);
      // Navigate to CheckInScreen with the validated permanent classroom QR payload
      navigation.navigate('CheckIn', { qrPayload: validation.payload });
    },
    [isProcessing, navigation],
  );

  const objectOutput = useObjectOutput({
    types: ['qr'],
    onObjectsScanned: (objects: any[]) => {
      if (isProcessing) return;
      for (const obj of objects) {
        if (obj.type === 'qr' && obj.value) {
          handleScannedText(obj.value);
          break;
        }
      }
    },
  });

  const handleRequestPermission = async () => {
    const granted = await requestPermission();
    if (!granted) {
      setErrorBanner('Camera permission is required to scan classroom QR codes.');
    }
  };

  if (!hasPermission) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <StatusBar barStyle="light-content" backgroundColor="#000" />
        <View style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBtn}>
            <Text style={styles.headerBtnText}>← Back</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Scan Attendance QR</Text>
          <View style={styles.headerSpacer} />
        </View>

        <View style={styles.centerContent}>
          <Text style={styles.permissionIcon}>📷</Text>
          <Text style={styles.permissionTitle}>Camera Permission Required</Text>
          <Text style={styles.permissionDesc}>
            AttendClass requires camera access to scan the permanent classroom attendance QR code.
          </Text>
          <TouchableOpacity style={styles.primaryBtn} onPress={handleRequestPermission}>
            <Text style={styles.primaryBtnText}>Grant Camera Permission</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  if (!device) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <StatusBar barStyle="light-content" backgroundColor="#000" />
        <View style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBtn}>
            <Text style={styles.headerBtnText}>← Back</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Scan Attendance QR</Text>
          <View style={styles.headerSpacer} />
        </View>
        <View style={styles.centerContent}>
          <Text style={styles.permissionIcon}>⚠️</Text>
          <Text style={styles.permissionTitle}>Camera Not Available</Text>
          <Text style={styles.permissionDesc}>
            No rear camera device detected on this phone.
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#000" />

      {/* Rear Camera Preview */}
      <Camera
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={isFocused && !isProcessing}
        outputs={[objectOutput]}
        torchMode={torch ? 'on' : 'off'}
      />

      {/* Darkened Overlay with Viewfinder cutout */}
      <SafeAreaView style={styles.overlayContainer} edges={['top', 'bottom']}>
        {/* Top bar */}
        <View style={styles.header}>
          <TouchableOpacity onPress={() => navigation.goBack()} style={styles.headerBtn}>
            <Text style={styles.headerBtnText}>← Back</Text>
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Classroom Scanner</Text>
          <TouchableOpacity
            onPress={() => setTorch((prev) => !prev)}
            style={styles.headerBtn}
          >
            <Text style={styles.headerBtnText}>{torch ? '🔦 On' : '🔦 Off'}</Text>
          </TouchableOpacity>
        </View>

        {/* Viewfinder Target Frame */}
        <View style={styles.viewfinderContainer}>
          <View style={styles.viewfinder}>
            {/* Top-left corner */}
            <View style={[styles.corner, styles.cornerTL]} />
            {/* Top-right corner */}
            <View style={[styles.corner, styles.cornerTR]} />
            {/* Bottom-left corner */}
            <View style={[styles.corner, styles.cornerBL]} />
            {/* Bottom-right corner */}
            <View style={[styles.corner, styles.cornerBR]} />

            {isProcessing && (
              <View style={styles.processingOverlay}>
                <ActivityIndicator size="large" color={T.colors.primary} />
                <Text style={styles.processingText}>Verifying Terminal…</Text>
              </View>
            )}
          </View>
          <Text style={styles.instructionText}>
            Align the classroom attendance QR code within the frame
          </Text>
        </View>

        {/* Error banner if invalid QR is scanned */}
        {errorBanner ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorBannerText}>⚠️ {errorBanner}</Text>
            <TouchableOpacity onPress={() => setErrorBanner(null)} style={styles.errorDismissBtn}>
              <Text style={styles.errorDismissText}>✕</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        <View style={styles.footer}>
          <Text style={styles.footerNote}>
            Each classroom has a permanent QR code on the wall or attendance box.
          </Text>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
  },
  overlayContainer: {
    flex: 1,
    justifyContent: 'space-between',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: T.spacing.lg,
    paddingVertical: T.spacing.md,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  headerBtn: {
    paddingVertical: T.spacing.xs,
    paddingHorizontal: T.spacing.sm,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: T.radius.md,
  },
  headerBtnText: {
    color: '#fff',
    fontSize: T.fontSize.sm,
    fontWeight: '700',
  },
  headerTitle: {
    color: '#fff',
    fontSize: T.fontSize.base,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  headerSpacer: {
    width: 48,
  },
  viewfinderContainer: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewfinder: {
    width: VIEWFINDER_SIZE,
    height: VIEWFINDER_SIZE,
    position: 'relative',
    backgroundColor: 'transparent',
  },
  corner: {
    position: 'absolute',
    width: 28,
    height: 28,
    borderColor: '#38bdf8', // bright accent cyan/blue for high visibility
  },
  cornerTL: {
    top: 0,
    left: 0,
    borderTopWidth: 4,
    borderLeftWidth: 4,
    borderTopLeftRadius: 6,
  },
  cornerTR: {
    top: 0,
    right: 0,
    borderTopWidth: 4,
    borderRightWidth: 4,
    borderTopRightRadius: 6,
  },
  cornerBL: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 4,
    borderLeftWidth: 4,
    borderBottomLeftRadius: 6,
  },
  cornerBR: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 4,
    borderRightWidth: 4,
    borderBottomRightRadius: 6,
  },
  processingOverlay: {
    ...StyleSheet.absoluteFill,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: T.radius.md,
  },
  processingText: {
    color: '#fff',
    fontSize: T.fontSize.sm,
    fontWeight: '700',
    marginTop: 8,
  },
  instructionText: {
    color: '#e2e8f0',
    fontSize: T.fontSize.sm,
    fontWeight: '600',
    textAlign: 'center',
    marginTop: 20,
    paddingHorizontal: T.spacing.xl,
    textShadowColor: 'rgba(0,0,0,0.7)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  errorBanner: {
    backgroundColor: '#b91c1c',
    marginHorizontal: T.spacing.lg,
    padding: T.spacing.md,
    borderRadius: T.radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    ...T.shadow.md,
  },
  errorBannerText: {
    color: '#fff',
    fontSize: T.fontSize.xs,
    fontWeight: '700',
    flex: 1,
    marginRight: 8,
  },
  errorDismissBtn: {
    padding: 4,
  },
  errorDismissText: {
    color: '#fff',
    fontSize: T.fontSize.base,
    fontWeight: '800',
  },
  footer: {
    padding: T.spacing.lg,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
  },
  footerNote: {
    color: '#94a3b8',
    fontSize: T.fontSize.xs,
    textAlign: 'center',
  },
  centerContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: T.spacing.xl,
  },
  permissionIcon: {
    fontSize: 54,
    marginBottom: 16,
  },
  permissionTitle: {
    color: '#fff',
    fontSize: T.fontSize.xl,
    fontWeight: '800',
    marginBottom: 8,
    textAlign: 'center',
  },
  permissionDesc: {
    color: '#94a3b8',
    fontSize: T.fontSize.sm,
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 20,
  },
  primaryBtn: {
    backgroundColor: T.colors.primary,
    paddingVertical: T.spacing.md,
    paddingHorizontal: T.spacing.xl,
    borderRadius: T.radius.lg,
    alignItems: 'center',
  },
  primaryBtnText: {
    color: '#fff',
    fontSize: T.fontSize.base,
    fontWeight: '700',
  },
});
