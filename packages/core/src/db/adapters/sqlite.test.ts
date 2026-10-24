// @archon-test-isolated
import { registerAdapterTests, registerFailureLoggingTests } from './__tests__/sqlite-adapter';
import { setupSqliteTests } from './__tests__/sqlite-fixtures';
import {
  registerBusyLocksTests,
  registerDialectTests,
  registerFinalizationTests,
  registerFreshSchemaTests,
} from './__tests__/sqlite-resources';

const shared = setupSqliteTests();
registerFailureLoggingTests(shared);
registerAdapterTests(shared);
registerFinalizationTests(shared);
registerBusyLocksTests(shared);
registerFreshSchemaTests(shared);
registerDialectTests();
