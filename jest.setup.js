/* eslint-disable no-undef */
// Jest setup for React Native and native dependencies

// Mock react-native-keychain
jest.mock('react-native-keychain', () => {
  let mockStorage = {};
  return {
    SECURITY_LEVEL: {
      SECURE_SOFTWARE: 0,
      SECURE_HARDWARE: 1,
      ANY: 2,
    },
    ACCESSIBLE: {
      WHEN_UNLOCKED: 'AccessibleWhenUnlocked',
      AFTER_FIRST_UNLOCK: 'AccessibleAfterFirstUnlock',
      ALWAYS: 'AccessibleAlways',
      WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 'AccessibleWhenPasscodeSetThisDeviceOnly',
      WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'AccessibleWhenUnlockedThisDeviceOnly',
      AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AccessibleAfterFirstUnlockThisDeviceOnly',
    },
    ACCESS_CONTROL: {
      USER_PRESENCE: 'UserPresence',
      BIOMETRY_ANY: 'BiometryAny',
      BIOMETRY_CURRENT_SET: 'BiometryCurrentSet',
      DEVICE_PASSCODE: 'DevicePasscode',
      APPLICATION_PASSWORD: 'ApplicationPassword',
      BIOMETRY_ANY_OR_DEVICE_PASSCODE: 'BiometryAnyOrDevicePasscode',
      BIOMETRY_CURRENT_SET_OR_DEVICE_PASSCODE: 'BiometryCurrentSetOrDevicePasscode',
    },
    AUTHENTICATION_TYPE: {
      DEVICE_PASSCODE_OR_BIOMETRICS: 'AuthenticationWithBiometricsDevicePasscode',
      BIOMETRICS: 'AuthenticationWithBiometrics',
    },
    BIOMETRY_TYPE: {
      TOUCH_ID: 'TouchID',
      FACE_ID: 'FaceID',
      FINGERPRINT: 'Fingerprint',
      FACE: 'Face',
      IRIS: 'Iris',
    },
    STORAGE_TYPE: {
      AES_GCM: 'KeystoreAESGCM',
      AES_GCM_NO_AUTH: 'KeystoreAESGCM_NoAuth',
      RSA: 'KeystoreRSAECB',
    },
    getSupportedBiometryType: jest.fn().mockResolvedValue('Fingerprint'),
    canImplyAuthentication: jest.fn().mockResolvedValue(true),
    isPasscodeAuthAvailable: jest.fn().mockResolvedValue(true),
    getSecurityLevel: jest.fn().mockResolvedValue(1),
    setGenericPassword: jest.fn().mockImplementation((username, password, options = {}) => {
      const service = options.service || 'default';
      mockStorage[service] = { username, password, service };
      return Promise.resolve({ service, storage: 'Keystore' });
    }),
    getGenericPassword: jest.fn().mockImplementation((options = {}) => {
      const service = options?.service || 'default';
      if (mockStorage[service]) {
        return Promise.resolve(mockStorage[service]);
      }
      return Promise.resolve(false);
    }),
    resetGenericPassword: jest.fn().mockImplementation((options = {}) => {
      const service = options?.service || 'default';
      delete mockStorage[service];
      return Promise.resolve(true);
    }),
    hasGenericPassword: jest.fn().mockImplementation((options = {}) => {
      const service = options?.service || 'default';
      return Promise.resolve(!!mockStorage[service]);
    }),
    __resetMockStorage: () => {
      mockStorage = {};
    },
    __setMockStorage: (service, val) => {
      mockStorage[service] = val;
    },
  };
});

// Mock react-native-ble-plx
jest.mock('react-native-ble-plx', () => {
  const mockBleManagerInstance = {
    startDeviceScan: jest.fn(),
    stopDeviceScan: jest.fn(),
    connectToDevice: jest.fn(),
    discoverAllServicesAndCharacteristicsForDevice: jest.fn(),
    readCharacteristicForDevice: jest.fn(),
    writeCharacteristicWithResponseForDevice: jest.fn(),
    writeCharacteristicWithoutResponseForDevice: jest.fn(),
    monitorCharacteristicForDevice: jest.fn(),
    cancelDeviceConnection: jest.fn(),
    state: jest.fn().mockResolvedValue('PoweredOn'),
    onStateChange: jest.fn((cb) => {
      cb('PoweredOn');
      return { remove: jest.fn() };
    }),
    destroy: jest.fn(),
  };

  return {
    BleManager: jest.fn().mockImplementation(() => mockBleManagerInstance),
    mockBleManagerInstance,
  };
});

// Mock react-native-safe-area-context
jest.mock('react-native-safe-area-context', () => {
  const React = require('react');
  const insetsContext = React.createContext({ top: 0, bottom: 0, left: 0, right: 0 });
  const frameContext = React.createContext({ x: 0, y: 0, width: 375, height: 812 });
  return {
    SafeAreaProvider: ({ children }) => children,
    SafeAreaView: ({ children, style }) => React.createElement('View', { style }, children),
    SafeAreaInsetsContext: insetsContext,
    SafeAreaFrameContext: frameContext,
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
    useSafeAreaFrame: () => ({ x: 0, y: 0, width: 375, height: 812 }),
  };
});

// Mock react-native-screens
jest.mock('react-native-screens', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    enableScreens: jest.fn(),
    enableFreeze: jest.fn(),
    screensEnabled: jest.fn(() => true),
    freezeEnabled: jest.fn(() => false),
    compatibilityFlags: {},
    featureFlags: {},
    Screen: View,
    InnerScreen: View,
    ScreenContext: React.createContext(null),
    ScreenStackHeaderConfig: View,
    ScreenStackHeaderSubview: View,
    ScreenStackHeaderLeftView: View,
    ScreenStackHeaderCenterView: View,
    ScreenStackHeaderRightView: View,
    ScreenStackHeaderBackButtonImage: View,
    ScreenStackHeaderSearchBarView: View,
    SearchBar: View,
    ScreenContainer: View,
    ScreenStack: View,
    ScreenStackItem: View,
    FullWindowOverlay: View,
    ScreenFooter: View,
    ScreenContentWrapper: View,
  };
});

// Mock react-native-reanimated
jest.mock('react-native-reanimated', () => {
  const Reanimated = require('react-native-reanimated/mock');
  Reanimated.default.call = () => {};
  return Reanimated;
});

// Mock react-native-vision-camera
jest.mock('react-native-vision-camera', () => ({
  Camera: {
    requestCameraPermission: jest.fn().mockResolvedValue('granted'),
    getCameraPermissionStatus: jest.fn().mockResolvedValue('granted'),
  },
  useCameraDevice: jest.fn().mockReturnValue({ id: 'front-camera' }),
  useCameraPermission: jest.fn().mockReturnValue({
    hasPermission: true,
    requestPermission: jest.fn().mockResolvedValue(true),
  }),
  usePhotoOutput: jest.fn().mockReturnValue({}),
}));

// Mock react-native-fast-tflite
jest.mock('react-native-fast-tflite', () => ({
  useTensorflowModel: jest.fn().mockReturnValue({
    model: {
      runSync: jest.fn().mockReturnValue([new Float32Array(128)]),
    },
    state: 'loaded',
  }),
}));

// Mock react-native-vision-camera-face-detector
jest.mock('react-native-vision-camera-face-detector', () => ({
  useImageFaceDetector: jest.fn().mockReturnValue({
    detectFaces: jest.fn().mockResolvedValue([]),
  }),
}));

// Mock react-native-nitro-image
jest.mock('react-native-nitro-image', () => ({
  Images: {
    loadFromRawPixelData: jest.fn().mockReturnValue({
      crop: jest.fn().mockReturnThis(),
      resize: jest.fn().mockReturnThis(),
      toRawPixelData: jest.fn().mockReturnValue({
        buffer: new ArrayBuffer(112 * 112 * 4),
        pixelFormat: 'RGBA',
      }),
    }),
  },
}));

// Mock react-native-dotenv
jest.mock('react-native-dotenv', () => ({
  SUPABASE_URL: 'https://test-supabase-project.supabase.co',
  SUPABASE_ANON_KEY: 'test-anon-key',
}));
