package handlers

import "net/http"

const (
	corsMethodsGET  = "GET, OPTIONS"
	corsMethodsPOST = "POST, OPTIONS"
	corsHeadersJSON = "Content-Type"
	corsHeadersAuth = "Content-Type, Authorization"
)

func setCORSHeaders(w http.ResponseWriter, methods, allowHeaders string) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	if methods != "" {
		w.Header().Set("Access-Control-Allow-Methods", methods)
	}
	if allowHeaders != "" {
		w.Header().Set("Access-Control-Allow-Headers", allowHeaders)
	}
}

// handleCORSPreflight writes the shared CORS preflight response when method is OPTIONS.
// Returns true when the request was handled as a preflight.
func handleCORSPreflight(w http.ResponseWriter, r *http.Request, methods, allowHeaders string) bool {
	if r.Method != http.MethodOptions {
		return false
	}
	setCORSHeaders(w, methods, allowHeaders)
	w.WriteHeader(http.StatusOK)
	return true
}

// requireMethod rejects non-matching methods with 405.
func requireMethod(w http.ResponseWriter, r *http.Request, method string) bool {
	if r.Method == method {
		return true
	}
	http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
	return false
}
