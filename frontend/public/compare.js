(function () {
    const {
        parseCsvText,
        renderCompareSection
    } = window.BpwCompareShared || {};

    const inputA = document.getElementById('compare-a-input');
    const inputB = document.getElementById('compare-b-input');
    const nameA = document.getElementById('compare-a-name');
    const nameB = document.getElementById('compare-b-name');
    const hint = document.getElementById('compare-hint');

    let samplesA = [];
    let samplesB = [];
    let fileAName = '';
    let fileBName = '';

    function updateHint(message) {
        if (hint) hint.textContent = message;
    }

    function tryRender() {
        if (!samplesA.length || !samplesB.length) {
            updateHint('Select both CSV files to render the comparison.');
            return;
        }
        const baseLabel = fileAName ? `Build A (${fileAName})` : 'Build A';
        const compareLabel = fileBName ? `Build B (${fileBName})` : 'Build B';
        renderCompareSection({
            baseSamples: samplesA,
            compareSamplesRaw: samplesB,
            compareSectionId: 'compare-section',
            compareModeStorageKey: 'compareMode',
            baseLabel,
            compareLabel,
            headerTitle: 'Comparison',
            headerSubtitle: 'Replay both CSV runs with a shared timeline',
            memoryFilenameBase: 'build-compare',
            gcFilenameBase: 'build-compare-gc',
            ratioFilenameBase: 'build-compare-rss-heap'
        });
        updateHint('Comparison rendered below. Use the replay controls to inspect changes over time.');
    }

    function handleFileChange(input, setSamples, setName) {
        const file = input.files && input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const text = String(reader.result || '');
                const parsed = parseCsvText(text);
                setSamples(parsed);
                setName(file.name);
                tryRender();
            } catch (err) {
                console.error('Failed to parse CSV', err);
                setSamples([]);
                setName('Failed to parse CSV');
                updateHint('Failed to parse CSV. Please check the file format.');
            }
        };
        reader.readAsText(file);
    }

    if (inputA) {
        inputA.addEventListener('change', () => {
            handleFileChange(inputA, (next) => { samplesA = next; }, (next) => {
                fileAName = next;
                if (nameA) nameA.textContent = next || 'No file selected';
            });
        });
    }

    if (inputB) {
        inputB.addEventListener('change', () => {
            handleFileChange(inputB, (next) => { samplesB = next; }, (next) => {
                fileBName = next;
                if (nameB) nameB.textContent = next || 'No file selected';
            });
        });
    }
})();
