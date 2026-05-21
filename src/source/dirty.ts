export interface DirtyCheckResult {
  dirty: boolean;
  currentHash: string;
  baselineHash: string | null;
}

export function isSkillDirty(currentHash: string, baselineHash: string | null): DirtyCheckResult {
  if (baselineHash === null) {
    return { dirty: false, currentHash, baselineHash };
  }

  return {
    dirty: currentHash !== baselineHash,
    currentHash,
    baselineHash
  };
}

export interface DirtySkill {
  name: string;
  path: string;
  currentHash: string;
  baselineHash: string;
}
