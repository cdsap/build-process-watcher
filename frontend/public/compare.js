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

    let samplesA = [];
    let samplesB = [];
    let summaryA = null;
    let summaryB = null;
    let fileAName = '';
    let fileBName = '';

    function updateHint(message) {
        if (hint) hint.textContent = message;
    }

    function tryRender() {
        if (!samplesA.length || !samplesB.length) {
            updateHint('Select both JSON files to render the comparison.');
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
            ratioFilenameBase: 'build-compare-rss-heap',
            baseProcessSummary: summaryA,
            compareProcessSummary: summaryB
        });
        updateHint('Comparison rendered below. Use the replay controls to inspect changes over time.');
    }

    function handleFileChange(input, setSamples, setSummary, setName) {
        const file = input.files && input.files[0];
        if (!file) return;
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
                    updateHint('JSON is missing samples.');
                    return;
                }
                if (!hasProcessInfo) {
                    updateHint('JSON is missing process info. Please export from the run page.');
                }
                setSamples(parsed.samples || []);
                setSummary(parsed.processSummary || null);
                setName(file.name);
                tryRender();
            } catch (err) {
                console.error('Failed to parse JSON', err);
                setSamples([]);
                setSummary(null);
                setName('Failed to parse JSON');
                updateHint('Failed to parse JSON. Please check the file format.');
            }
        };
        reader.readAsText(file);
    }

    if (inputA) {
        inputA.addEventListener('change', () => {
            handleFileChange(
                inputA,
                (next) => { samplesA = next; },
                (next) => { summaryA = next; },
                (next) => {
                fileAName = next;
                if (nameA) nameA.textContent = next || 'No file selected';
            });
        });
    }

    if (inputB) {
        inputB.addEventListener('change', () => {
            handleFileChange(
                inputB,
                (next) => { samplesB = next; },
                (next) => { summaryB = next; },
                (next) => {
                fileBName = next;
                if (nameB) nameB.textContent = next || 'No file selected';
            });
        });
    }
})();
