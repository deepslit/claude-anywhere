import { useEffect, useState } from "react";

const KEY_STORAGE = "mobile_cc_api_key";

export function useApiKey() {
  const [key, setKeyState] = useState<string | null>(() => {
    try {
      return localStorage.getItem(KEY_STORAGE);
    } catch {
      return null;
    }
  });

  useEffect(() => {
    if (key) {
      try {
        localStorage.setItem(KEY_STORAGE, key);
      } catch {
        // ignore
      }
    }
  }, [key]);

  const clear = () => {
    try {
      localStorage.removeItem(KEY_STORAGE);
    } catch {
      // ignore
    }
    setKeyState(null);
  };

  return { key, setKey: setKeyState, clear };
}
