import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const eslintConfig = [
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      "react-hooks/immutability": "off",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
      // The app does not enable React Compiler; retain its existing manual hooks.
      "react-hooks/preserve-manual-memoization": "off",
    },
  },
];

export default eslintConfig;
