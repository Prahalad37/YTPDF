import { AnimatePresence, motion } from 'framer-motion'
import type { StudioViewModel } from '../../hooks/useStudioApp'
import { StudioBottomBar } from './StudioBottomBar'
import { StudioMainStage } from './StudioMainStage'
import { StudioSidebar } from './StudioSidebar'
import { StudioTopBar } from './StudioTopBar'

export function StudioWorkspace({ vm }: { vm: StudioViewModel }) {
  return (
    <div className="flex h-screen min-h-0 flex-col overflow-hidden">
      <StudioTopBar sourcePath={vm.sourcePath} job={vm.job} />

      <div className="flex min-h-0 flex-1">
        <StudioSidebar
          sourcePath={vm.sourcePath}
          job={vm.job}
          sampleEverySec={vm.sampleEverySec}
          setSampleEverySec={vm.setSampleEverySec}
          cooldownSecStr={vm.cooldownSecStr}
          setCooldownSecStr={vm.setCooldownSecStr}
          changeThresholdStr={vm.changeThresholdStr}
          setChangeThresholdStr={vm.setChangeThresholdStr}
          ocrLanguageStr={vm.ocrLanguageStr}
          setOcrLanguageStr={vm.setOcrLanguageStr}
          pdfExports={vm.pdfExports}
          extractionPreset={vm.extractionPreset}
          setExtractionPreset={vm.setExtractionPreset}
          advancedOpen={vm.advancedOpen}
          setAdvancedOpen={vm.setAdvancedOpen}
          useCustomCapture={vm.useCustomCapture}
          setUseCustomCapture={vm.setUseCustomCapture}
          pickFile={vm.pickFile}
          onDrop={vm.onDrop}
          startJob={vm.startJob}
          rerunSameFile={vm.rerunSameFile}
          openJobOutputsFolder={vm.openJobOutputsFolder}
          cancelJob={vm.cancelJob}
          pauseJob={vm.pauseJob}
          resumeJob={vm.resumeJob}
          savePdf={vm.savePdf}
          openPdf={vm.openPdf}
          canUsePdfOutput={vm.canUsePdfOutput}
          openExportPdf={vm.openExportPdf}
          saveExportCopy={vm.saveExportCopy}
          viewExportJob={vm.viewExportJob}
          renameExport={vm.renameExport}
          deleteExport={vm.deleteExport}
          active={vm.active}
          startLocked={vm.startLocked}
          generateAnswerKey={vm.generateAnswerKey}
          generateRevisionSheet={vm.generateRevisionSheet}
          exportMcqTxt={vm.exportMcqTxt}
          generateShuffledPractice={vm.generateShuffledPractice}
          tagMcqTopics={vm.tagMcqTopics}
          mcqBusy={vm.mcqBusy}
          secondaryMcqBusy={vm.secondaryMcqBusy}
          runOcrAnalysis={vm.runOcrAnalysis}
          rebuildStudyPdf={vm.rebuildStudyPdf}
          ocrBusy={vm.ocrBusy}
          rebuildBusy={vm.rebuildBusy}
        />

        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <StudioMainStage
            job={vm.job}
            frames={vm.frames}
            pipelineUiBusy={vm.pipelineUiBusy}
            ocrBusy={vm.ocrBusy}
            rebuildBusy={vm.rebuildBusy}
            mcqBusy={vm.mcqBusy}
            mcqProgressPayload={vm.mcqProgressPayload}
            mcqAiMode={vm.mcqAiMode}
            setMcqAiMode={vm.setMcqAiMode}
            generateMcqPdfAuto={vm.generateMcqPdfAuto}
            cancelMcqPdf={vm.cancelMcqPdf}
            toggleFrameInclude={vm.toggleFrameInclude}
            duplicateGroupIndex={vm.duplicateGroupIndex}
            duplicateGroupSizes={vm.duplicateGroupSizes}
            analyzeQuestionPatterns={vm.analyzeQuestionPatterns}
            formatTimestamp={vm.formatTimestamp}
            timeSavedMin={vm.timeSavedMin}
            junkPct={vm.junkPct}
            studentState={vm.studentState}
            toggleBookmark={vm.toggleBookmark}
            toggleSolved={vm.toggleSolved}
            generateWeakTopicPdf={vm.generateWeakTopicPdf}
            secondaryMcqBusy={vm.secondaryMcqBusy}
            openPdf={vm.openPdf}
            canUsePdfOutput={vm.canUsePdfOutput}
            savePdf={vm.savePdf}
            exportMcqTxt={vm.exportMcqTxt}
            generateShuffledPractice={vm.generateShuffledPractice}
          />
          <StudioBottomBar
            job={vm.job}
            galleryFrameCount={vm.frames.length}
            logsOpen={vm.logsOpen}
            setLogsOpen={vm.setLogsOpen}
          />
        </div>
      </div>

      <AnimatePresence>
        {vm.error ? (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="fixed bottom-20 left-1/2 z-[60] max-w-md -translate-x-1/2 rounded-xl border border-rose-500/30 bg-rose-950/95 px-4 py-3 text-sm text-rose-100 shadow-2xl"
            role="alert"
          >
            {vm.error}
            <button
              type="button"
              className="ml-3 text-xs text-rose-300 underline"
              onClick={() => vm.setError(null)}
            >
              Dismiss
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  )
}
