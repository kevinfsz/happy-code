import { authAndSetupMachineIfNeeded } from '@/ui/auth'
import { ensureDaemonRunning } from '@/daemon/ensureDaemonRunning'
import { clearGenericProxyEnv } from './clearGenericProxyEnv'
import { assertOpenCodeCliAvailable, runOpenCode } from '@/opencode/runOpenCode'

export async function handleOpencodeCommand(args: string[]): Promise<void> {
  let startedBy: 'daemon' | 'terminal' | undefined = undefined
  let verbose = false
  const localArgs: string[] = []

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--started-by') {
      startedBy = args[++i] as 'daemon' | 'terminal'
      continue
    }
    if (args[i] === '--verbose') {
      verbose = true
      continue
    }
    localArgs.push(args[i])
  }

  clearGenericProxyEnv()
  assertOpenCodeCliAvailable('opencode')
  const { credentials } = await authAndSetupMachineIfNeeded()
  await ensureDaemonRunning()

  await runOpenCode({
    credentials,
    startedBy,
    verbose,
    localCommand: 'opencode',
    localArgs,
    remoteCommand: 'opencode',
    remoteArgs: [...localArgs],
  })
}
