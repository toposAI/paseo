import { useCallback } from "react";
import { SettingsAction, SettingsCard, SettingsSection } from "@/components/settings";

// 139番iOSアプリ(Dictation139)のWKWebView内でのみ、ネイティブが
// `dictation139` というメッセージハンドラを注入する。通常のブラウザには無いので非表示。
interface Dictation139Bridge {
  postMessage(message: { action: "openRecording" }): void;
}

function getDictation139Bridge(): Dictation139Bridge | null {
  if (typeof window === "undefined") return null;
  const webkit = (
    window as { webkit?: { messageHandlers?: { dictation139?: Dictation139Bridge } } }
  ).webkit;
  return webkit?.messageHandlers?.dictation139 ?? null;
}

export function RecordingSection() {
  const bridge = getDictation139Bridge();
  const open = useCallback(() => {
    getDictation139Bridge()?.postMessage({ action: "openRecording" });
  }, []);
  if (!bridge) return null;
  return (
    <SettingsSection title="録音">
      <SettingsCard>
        <SettingsAction
          label="録音アプリ"
          hint="音声入力・録音の画面を開きます"
          actionLabel="開く"
          onPress={open}
        />
      </SettingsCard>
    </SettingsSection>
  );
}
