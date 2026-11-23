(function () {
    const {
        parseJsonText,
        renderCompareSection
    } = window.BpwCompareShared || {};

    const inputA = document.getElementById('compare-a-input');
    const inputB = document.getElementById('compare-b-input');
    const nameA = document.getElementById('compare-a-name');
    const nameB = document.getElementById('compare-b-name');
    const hint = document.getElementById('compare-hint');
    const swapBtn = document.getElementById('btn-compare-swap');
    const clearBtn = document.getElementById('btn-compare-clear');
    const dropzone = document.getElementById('compare-dropzone');
    const section = document.getElementById('compare-section');

    let samplesA = [];
    let samplesB = [];
    let summaryA = null;
    let summaryB = null;
    let fileAName = '';
    let fileBName = '';
    let missingProcessInfoA = false;
    let missingProcessInfoB = false;

    function updateHint(message) {
        if (hint) hint.textContent = message;
    }

    function syncActionButtons() {
        const hasAny = samplesA.length > 0 || samplesB.length > 0;
        const hasBoth = samplesA.length > 0 && samplesB.length > 0;
        if (swapBtn) swapBtn.disabled = !hasBoth;
        if (clearBtn) clearBtn.disabled = !hasAny;
    }

    function tryRender() {
        syncActionButtons();
        if (!samplesA.length || !samplesB.length) {
            if (window.compareReplayStops?.default) {
                window.compareReplayStops.default();
                window.compareReplayStops.default = null;
            }
            if (section) {
                section.style.display = 'none';
                section.innerHTML = '';
            }
            updateHint('Select or drop two JSON files to render the comparison.');
            return;
        }
        const baseLabel = fileAName ? `Run A (${fileAName})` : 'Run A';
        const compareLabel = fileBName ? `Run B (${fileBName})` : 'Run B';
        renderCompareSection({
            baseSamples: samplesA,
            compareSamplesRaw: samplesB,
            compareSectionId: 'compare-section',
            compareModeStorageKey: 'compareMode',
            baseLabel,
            compareLabel,
            headerTitle: 'Comparison',
            headerSubtitle: 'Replay both JSON runs with a shared timeline',
            memoryFilenameBase: 'build-compare',
            gcFilenameBase: 'build-compare-gc',
            baseProcessSummary: summaryA,
            compareProcessSummary: summaryB
        });
        if (missingProcessInfoA || missingProcessInfoB) {
            updateHint('Comparison rendered. Process metadata is missing from at least one JSON; export from a run page for VM flag diffs.');
        } else {
            updateHint('Comparison rendered below.');
        }
    }

    function loadFile(file, slot) {
        if (!file) return;
        const setSamples = (next) => { if (slot === 'a') samplesA = next; else samplesB = next; };
        const setSummary = (next) => { if (slot === 'a') summaryA = next; else summaryB = next; };
        const setMissingInfo = (next) => { if (slot === 'a') missingProcessInfoA = next; else missingProcessInfoB = next; };
        const setName = (next) => {
            if (slot === 'a') {
                fileAName = next;
                if (nameA) nameA.textContent = next || 'No file selected';
            } else {
                fileBName = next;
                if (nameB) nameB.textContent = next || 'No file selected';
            }
        };
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const text = String(reader.result || '');
                const parsed = parseJsonText(text);
                const hasSamples = parsed.samples && parsed.samples.length > 0;
                const hasProcessInfo = parsed.processInfo && Object.keys(parsed.processInfo).length > 0;
                if (!hasSamples) {
                    setSamples([]);
                    setSummary(null);
                    setMissingInfo(false);
                    syncActionButtons();
                    updateHint('JSON is missing samples.');
                    return;
                }
                setMissingInfo(!hasProcessInfo);
                setSamples(parsed.samples || []);
                setSummary(parsed.processSummary || null);
                setName(file.name);
                tryRender();
            } catch (err) {
                console.error('Failed to parse JSON', err);
                setSamples([]);
                setSummary(null);
                setMissingInfo(false);
                setName('Failed to parse JSON');
                syncActionButtons();
                updateHint('Failed to parse JSON. Please check the file format.');
            }
        };
        reader.readAsText(file);
    }

    if (inputA) {
        inputA.addEventListener('change', () => {
            loadFile(inputA.files && inputA.files[0], 'a');
        });
    }

    if (inputB) {
        inputB.addEventListener('change', () => {
            loadFile(inputB.files && inputB.files[0], 'b');
        });
    }

    if (swapBtn) {
        swapBtn.addEventListener('click', () => {
            if (!samplesA.length || !samplesB.length) return;
            [samplesA, samplesB] = [samplesB, samplesA];
            [summaryA, summaryB] = [summaryB, summaryA];
            [fileAName, fileBName] = [fileBName, fileAName];
            [missingProcessInfoA, missingProcessInfoB] = [missingProcessInfoB, missingProcessInfoA];
            if (nameA) nameA.textContent = fileAName || 'No file selected';
            if (nameB) nameB.textContent = fileBName || 'No file selected';
            tryRender();
        });
    }

    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            samplesA = [];
            samplesB = [];
            summaryA = null;
            summaryB = null;
            fileAName = '';
            fileBName = '';
            missingProcessInfoA = false;
            missingProcessInfoB = false;
            if (inputA) inputA.value = '';
            if (inputB) inputB.value = '';
            if (nameA) nameA.textContent = 'No file selected';
            if (nameB) nameB.textContent = 'No file selected';
            tryRender();
        });
    }

    if (dropzone) {
        dropzone.addEventListener('dragover', (event) => {
            event.preventDefault();
            dropzone.classList.add('is-dragover');
        });
        dropzone.addEventListener('dragleave', () => {
            dropzone.classList.remove('is-dragover');
        });
        dropzone.addEventListener('drop', (event) => {
            event.preventDefault();
            dropzone.classList.remove('is-dragover');
            const files = Array.from(event.dataTransfer?.files || []).filter(f => /\.json$/i.test(f.name) || f.type === 'application/json');
            if (!files.length) return;
            if (files.length >= 2) {
                loadFile(files[0], 'a');
                loadFile(files[1], 'b');
            } else if (!samplesA.length) {
                loadFile(files[0], 'a');
            } else {
                loadFile(files[0], 'b');
            }
        });
    }
})();
