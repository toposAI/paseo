// Polyfill crypto.randomUUID for React Native before any other imports
import { polyfillCrypto } from "./src/polyfills/crypto";
polyfillCrypto();

// Polyfill screen.orientation for WebKitGTK desktop runtimes that lack the API.
import { polyfillScreenOrientation } from "./src/polyfills/screen-orientation";
polyfillScreenOrientation();

// Track the true visible viewport height on iOS Safari/standalone, where
// `100%` resolves against the layout viewport and leaves stale bottom space.
import { applyVisualViewportHeight } from "./src/polyfills/visual-viewport-height";
applyVisualViewportHeight();

// Configure Unistyles before Expo Router pulls in any components using StyleSheet.
import "./src/styles/unistyles";
import "expo-router/entry";
