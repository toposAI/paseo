import type { ComponentType, ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import type { ViewportFitOptions, ViewportSize, ViewportSwipeDirection } from "./geometry";

export interface ZoomableViewportAction {
  icon: ComponentType<{ size?: number; color?: string }>;
  label: string;
  onPress: () => void;
  testID?: string;
}

export interface ZoomableViewportProps {
  contentSize: ViewportSize;
  children: ReactNode;
  actions?: ZoomableViewportAction[];
  accessibilityLabel?: string;
  fit?: ViewportFitOptions;
  maxScale?: number;
  minScale?: number;
  onPressOutsideContent?: () => void;
  /** A horizontal swipe while not zoomed in; the caller moves to the neighbouring image. */
  onSwipe?: (direction: ViewportSwipeDirection) => void;
  /** Keep the buttons shown (and clickable) without hover, e.g. in a full-screen viewer. */
  alwaysShowControls?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  wheelActivation?: "always" | "modifier";
}
