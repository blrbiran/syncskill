import subprocess, json, os, sys, tempfile
SS=sys.argv[1]; OUT=sys.argv[2]
INT='tests/integration/profile-inject-cli.test.ts'
SRC_INT='tests/integration/source-resolved-commit.test.ts'
SRC_UNIT='tests/unit/source-state-commit.test.ts'
INJ_UNIT='tests/unit/inject-lock.test.ts'
CFG_UNIT='tests/unit/config-profiles.test.ts'
M=[
 ('M1 validateConfig drops profiles',[('src/config/config.ts','profiles: normalizeProfiles(value.profiles),','profiles: {},')],[INT,CFG_UNIT]),
 ('M2 normalizeSourceState drops resolved_commit',[('src/source.ts','        ? value.resolved_commit\n','        ? null\n')],[SRC_UNIT,SRC_INT,INT]),
 ('M3 resolved_commit never written',[('src/source.ts',"resolved_commit: source.type === 'git' ? await readGitHead(getGitCheckoutDir(homeDir, name)) : null",'resolved_commit: null')],[SRC_INT,INT]),
 ('M4 copy becomes symlink',[('src/inject.ts',"await cp(sourceDirs.get(skill)!, join(staging, skill), { recursive: true, dereference: true });","await symlink(sourceDirs.get(skill)!, join(staging, skill));"),('src/inject.ts',"import { cp, link, lstat, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';","import { cp, link, lstat, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';")],[INT]),
 ('M5 occupancy check removed',[('src/inject.ts','if (await exists(path)) {','if (false && await exists(path)) {')],[INT]),
 ('M6 target created before resolution',[('src/inject.ts','  const sourceDirs = new Map<string, string>();','  await mkdir(target, { recursive: true });\n  const sourceDirs = new Map<string, string>();')],[INT]),
 ('M7 dereference false',[('src/inject.ts','{ recursive: true, dereference: true }','{ recursive: true, dereference: false }')],[INT]),
 ('M8 lock placed by rename, lock not checked',[('src/inject.ts','await link(stagedLock, lockPath);','await rename(stagedLock, lockPath);'),('src/inject.ts','[...skills.map((skill) => join(target, skill)), lockPath]','[...skills.map((skill) => join(target, skill))]')],[INT]),
 ('M9 normalizeSkillList identity',[('src/inject.ts','return [...new Set(skills)].sort();','return skills;')],[INT,INJ_UNIT]),
 ('M10 profile set name guard off',[('src/index.ts','        if (!isSafeSkillName(skill)) {','        if (false) {')],[INT]),
 ('M11 profile set accepts __proto__',[('src/index.ts',"if (!PROFILE_NAME_PATTERN.test(name) || name === '__proto__') {","if (!PROFILE_NAME_PATTERN.test(name)) {")],[INT]),
 ('M12 hasOwn back to plain lookup in ls',[('src/index.ts',"if (name !== undefined && !Object.hasOwn(config.profiles, name)) {","if (name !== undefined && config.profiles[name] === undefined) {")],[INT]),
 ('M13 staging by pid inside try',[('src/inject.ts',"  const staging = await mkdtemp(join(target, '.syncskill-inject-'));\n  const placed: string[] = [];\n  try {\n","  const staging = join(target, `.syncskill-inject-${process.pid}`);\n  const placed: string[] = [];\n  try {\n    await mkdir(staging);\n")],[INT,'tests/unit/inject-rollback.test.ts']),
 ('M14 inject refreshes manifests',[('src/index.ts'," && getCommandPath(actionCommand) !== 'inject'",'')],[INT]),
]
def run(cmd,**kw): return subprocess.run(cmd,cwd=SS,capture_output=True,text=True,**kw)
res=[]
env=dict(os.environ); env['TMPDIR']=tempfile.mkdtemp(prefix='ssm',dir='/private/tmp')
SEL=sys.argv[3:]
for name,edits,tests in [m for m in M if not SEL or m[0].split()[0] in SEL]:
    for f,o,n in edits:
        p=os.path.join(SS,f); s=open(p).read(); c=s.count(o)
        if c!=1: res.append({'m':name,'error':f'anchor count {c} in {f}'}); break
        open(p,'w').write(s.replace(o,n))
    else:
        b=run(['npm','run','build'],env=env)
        jf=os.path.join(OUT,name.split()[0]+'.json')
        t=run(['./node_modules/.bin/vitest','run',*tests,'--reporter=json','--outputFile='+jf],env=env)
        failed=[]
        try:
            d=json.load(open(jf))
            for tr in d['testResults']:
                for a in tr['assertionResults']:
                    if a['status']!='passed': failed.append(a['title']+' ['+a['status']+']')
            counts=(d['numTotalTests'],d['numPassedTests'],d['numFailedTests'])
        except Exception as e: counts=str(e)
        res.append({'m':name,'build_rc':b.returncode,'test_rc':t.returncode,'counts':counts,'failed':failed})
    for f,_,_ in edits:
        r=subprocess.run(['/usr/bin/git','show','HEAD:'+f],cwd=SS,capture_output=True)
        open(os.path.join(SS,f),'wb').write(r.stdout)
d1=subprocess.run(['/usr/bin/git','diff'],cwd=SS,capture_output=True).stdout
d2=subprocess.run(['/usr/bin/git','diff','--cached'],cwd=SS,capture_output=True).stdout
b=run(['npm','run','build'],env=env)
res.append({'restore':{'diff_bytes':len(d1),'cached_bytes':len(d2),'rebuild_rc':b.returncode}})
json.dump(res,open(os.path.join(OUT,'summary.json'),'w'),indent=1)
print(json.dumps(res,indent=1))
