import type { ExpoConfig } from "expo/config";

const config: ExpoConfig = {
  name: "Cove Native",
  slug: "cove-native",
  version: "0.0.0",
  orientation: "default",
  ios: {
    bundleIdentifier: "com.ghostflying.cove.native",
    supportsTablet: true,
  },
  android: {
    package: "com.ghostflying.cove.nativeapp",
  },
  plugins: [
    [
      "expo-build-properties",
      {
        ios: { deploymentTarget: "16.0" },
        android: { minSdkVersion: 31, compileSdkVersion: 36, targetSdkVersion: 36 },
      },
    ],
    "expo-secure-store",
  ],
};

export default config;
