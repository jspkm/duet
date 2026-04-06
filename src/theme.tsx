import { createContext, useContext, useState, useEffect, type ReactNode } from "react";

type ThemeMode = "light" | "dark" | "auto";

interface ThemeContextValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  mode: "auto",
  setMode: () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(() => {
    const saved = localStorage.getItem("duet-theme");
    return (saved as ThemeMode) ?? "auto";
  });

  const setMode = (m: ThemeMode) => {
    setModeState(m);
    localStorage.setItem("duet-theme", m);
  };

  useEffect(() => {
    const root = document.documentElement;
    root.removeAttribute("data-theme");

    if (mode === "light") {
      root.setAttribute("data-theme", "light");
    } else if (mode === "dark") {
      root.setAttribute("data-theme", "dark");
    }
    // "auto" uses prefers-color-scheme via CSS
  }, [mode]);

  return (
    <ThemeContext.Provider value={{ mode, setMode }}>
      {children}
    </ThemeContext.Provider>
  );
}
