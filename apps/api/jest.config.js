module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  roots: ['<rootDir>/src', '<rootDir>/test', '<rootDir>/../../proprietary'],
  testRegex: '.*\\.(spec|e2e-spec)\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  collectCoverageFrom: [
    '**/*.(t|j)s',
  ],
  coverageDirectory: './coverage',
  testEnvironment: 'node',
  testTimeout: 30000,
  forceExit: true,
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  moduleNameMapper: {
    '^src/(.*)$': '<rootDir>/src/$1',
    '^@app/(.*)$': '<rootDir>/src/$1',
    '^@proprietary/ai/(.*)$': '<rootDir>/test/__mocks__/@proprietary/ai/$1',
    '^@proprietary/(.*)$': '<rootDir>/../../proprietary/$1',
    '^@betterdb/shared$': '<rootDir>/../../packages/shared/src/index',
    // Handle .js extensions in ESM imports
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
