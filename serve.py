"""Single-process, threaded local WSGI server."""
import os
from waitress import serve
from app import create_app

if __name__ == '__main__':
    serve(create_app(), host=os.environ.get('HOST', '127.0.0.1'),
          port=int(os.environ.get('PORT', 5000)), threads=4)
