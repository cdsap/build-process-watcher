package handlers

import (
	"net/http"

	"github.com/cdsap/build-process-watcher/backend/internal/httpx"
)

const (
	corsMethodsGET  = httpx.MethodsGET
	corsMethodsPOST = httpx.MethodsPOST
	corsHeadersJSON = httpx.HeadersJSON
	corsHeadersAuth = httpx.HeadersAuth
)

func setCORSHeaders(w http.ResponseWriter, methods, allowHeaders string) {
	httpx.SetCORSHeaders(w, methods, allowHeaders)
}

func handleCORSPreflight(w http.ResponseWriter, r *http.Request, methods, allowHeaders string) bool {
	return httpx.HandleCORSPreflight(w, r, methods, allowHeaders)
}

func requireMethod(w http.ResponseWriter, r *http.Request, method string) bool {
	return httpx.RequireMethod(w, r, method)
}
