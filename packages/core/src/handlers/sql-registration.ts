import * as codebases from '../db/codebases';
import * as registration from './clone';
export { inspectProjectBaseBranch, resolveForgeAuth, ProjectRegistrationError } from './clone';
export type { RegisterResult, RegistrationOptions, ProjectBaseBranchInspection } from './clone';

export const cloneRepository = registration.cloneRepository.bind(undefined, codebases);
export const registerRepository = registration.registerRepository.bind(undefined, codebases);
export const registerFolder = registration.registerFolder.bind(undefined, codebases);
