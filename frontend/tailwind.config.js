/** @type {import('tailwindcss').Config} */
export default {
  // index.html already carries <html class="dark">, but Tailwind defaults to
  // `media` — so `dark:` variants were following the OS setting rather than
  // that class. The app is unconditionally dark (hardcoded slate surfaces,
  // `color-scheme: dark`), so a light-OS visitor would have seen the light
  // halves of every `dark:` pair on a dark table. Class strategy makes the
  // existing attribute authoritative, and leaves room for a light theme later.
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: { extend: {} },
  plugins: [],
};
