import { useStudioApp } from './hooks/useStudioApp'
import { StudioWorkspace } from './components/studio/StudioWorkspace'

export default function App() {
  const vm = useStudioApp()

  if (!vm.api) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-950 px-6 text-center">
        <p className="text-zinc-400">
          Run Framebase AI (<code className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-200">npm run desktop</code>) to
          extract study PDFs locally.
        </p>
      </div>
    )
  }

  return <StudioWorkspace vm={vm} />
}
