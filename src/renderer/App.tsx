import { useEffect, useState } from "react";
import type { AuthState } from "../shared/types";
import { Splash } from "./screens/Splash";
import { AuthScreen } from "./screens/AuthScreen";
import { Picker } from "./screens/Picker";

const INITIAL: AuthState = { stage: "splash", user: null, error: null, apex: "" };

export default function App() {
  const [state, setState] = useState<AuthState>(INITIAL);

  useEffect(() => {
    window.aw.getState().then(setState);
    const unsubscribe = window.aw.onStateChanged(setState);
    return unsubscribe;
  }, []);

  switch (state.stage) {
    case "login":
    case "signup":
    case "forgot-password":
      return <AuthScreen state={state} />;
    case "picker":
      return <Picker state={state} />;
    case "loading-workspace":
      return <Splash label="Opening your workspace…" />;
    default:
      return <Splash label="AW Desktop" />;
  }
}
