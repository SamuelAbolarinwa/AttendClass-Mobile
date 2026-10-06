module.exports = {
  preset: '@react-native/jest-preset',
  setupFilesAfterEnv: ['./jest.setup.js'],
  transformIgnorePatterns: [
    'node_modules/(?!(jest-)?@?react-native|@react-native-community|@react-navigation|react-navigation|react-native-screens|react-native-safe-area-context|react-native-keychain|react-native-ble-plx|react-native-vision-camera|react-native-fast-tflite|react-native-nitro-image|react-native-reanimated|@noble)/',
  ],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
};
