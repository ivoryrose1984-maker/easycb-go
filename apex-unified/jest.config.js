module.exports = {
  preset:              'ts-jest',
  testEnvironment:     'node',
  testMatch:           ['**/src/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js'],
  setupFiles:          ['./src/__tests__/setup.ts'],
};
