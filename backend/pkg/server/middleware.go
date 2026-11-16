package server

import (
	"net/http"
	"strings"
)

const corsAllowedHeaders = "Content-Type, Authorization, X-BPW-Prediction-Job-Token, X-Admin-Secret"

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", corsAllowedHeaders)
		next.ServeHTTP(w, r)
	})
}

func allowMethods(methods ...string) func(http.Handler) http.Handler {
	allowed := make(map[string]struct{}, len(methods))
	for _, method := range methods {
		allowed[method] = struct{}{}
	}
	allowedMethods := append([]string(nil), methods...)
	allowHeader := strings.Join(append(allowedMethods, http.MethodOptions), ", ")

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Access-Control-Allow-Methods", allowHeader)
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusOK)
				return
			}
			if _, ok := allowed[r.Method]; !ok {
				w.Header().Set("Allow", allowHeader)
				http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func route(handler http.HandlerFunc, methods ...string) http.Handler {
	return withCORS(allowMethods(methods...)(handler))
}
