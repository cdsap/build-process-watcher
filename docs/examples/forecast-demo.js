/* This offline documentation demo never contacts a prediction provider. */
(async () => {
    const host = document.getElementById('forecast-demo');
    try {
        const response = await fetch('process-forecasts.json');
        if (!response.ok) throw new Error('Fixture unavailable');
        const data = await response.json();
        host.innerHTML = window.BpwPredictionView.render(data, null).html;
        window.BpwPredictionView.bindProcessForecastView(host, { data, initialMode: 'replay' });
    } catch (error) {
        host.textContent = 'Demo unavailable. Serve the repository over HTTP; see the forecast guide.';
    }
})();
