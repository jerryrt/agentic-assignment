// The workspace lint entrypoint. ESLint 9+ walks up from the working directory
// to find this, so every package resolves it without a config file of its own -
// which is what keeps the layering rule defined in exactly one place.
import lj from '@lj/eslint-config';

export default [...lj];
