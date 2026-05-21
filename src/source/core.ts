// During transition, re-export from legacy source.ts
// TODO: Move implementations here after commands/ split is complete
export {
  materializeSource,
  updateSource,
  removeSource,
  listSourcesWithDetails
} from '../source.js';
