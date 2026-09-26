"""HTTP surfaces.

`stt_server.py` is the speech service: loopback, two endpoints, its own port. It is
not `rest.py` - the REST API of PLAN 5.4 that serves the whole display is a
separate, larger job that has not been done, and `web/src/api/http.ts` remains its
written specification.
"""
