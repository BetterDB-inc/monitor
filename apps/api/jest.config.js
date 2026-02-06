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
  testPathIgnorePatterns: ['/node_modules/'],
  testTimeout: 30000,
  forceExit: true,
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  globalSetup: '<rootDir>/test/global-setup.ts',
  globalTeardown: '<rootDir>/test/global-teardown.ts',
  moduleNameMapper: {
    '^src/(.*)$': '<rootDir>/src/$1',
    '^@app/(.*)$': '<rootDir>/src/$1',
    '^@proprietary/ai/(.*)$': '<rootDir>/test/__mocks__/@proprietary/ai/$1',
    '^@proprietary/(.*)$': '<rootDir>/../../proprietary/$1',
    '^@betterdb/shared/encryption$': '<rootDir>/../../packages/shared/src/encryption',
    '^@betterdb/shared/license$': '<rootDir>/../../packages/shared/src/license/index',
    '^@betterdb/shared$': '<rootDir>/../../packages/shared/src/index',
    // Handle .js extensions in ESM imports
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
