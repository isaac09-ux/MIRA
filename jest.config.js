/**
 * Jest config para MIRA.
 *  - Default env: jsdom (los component tests lo necesitan)
 *  - Los archivos con `@jest-environment node` en el header corren en node
 *  - Transform vía @swc/jest (mismo motor que usa Next.js)
 */
module.exports = {
  testEnvironment: "jsdom",
  testMatch: ["<rootDir>/tests/**/*.test.{js,jsx}"],
  setupFilesAfterEnv: ["<rootDir>/jest.setup.js"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
  },
  transform: {
    "^.+\\.(js|jsx)$": [
      "@swc/jest",
      {
        jsc: {
          parser: { syntax: "ecmascript", jsx: true },
          transform: { react: { runtime: "automatic" } },
        },
      },
    ],
  },
  testPathIgnorePatterns: ["/node_modules/", "/.next/"],
  // El smoke test arranca next start → necesita tiempo y handles externos
  testTimeout: 60000,
  forceExit: true,
};
