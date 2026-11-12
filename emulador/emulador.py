"""
Lanza ELM327-emulator con una corrección para Windows.

En Windows, cuando un cliente TCP se desconecta de golpe, el socket lanza
ConnectionAbortedError (WinError 10053). El emulador solo maneja
ConnectionResetError, así que se queda en un bucle de errores y ya no acepta
nuevas conexiones. Aquí hacemos que ambos errores se traten igual.

Uso: python emulador.py [opciones de ELM327-emulator]   (ej. -n 35000 -s car)
"""

import sys

import elm.elm as elm_core
from elm.interpreter import main

# `except ConnectionResetError` dentro de elm.py busca el nombre en el módulo:
# lo sustituimos por la clase base, que incluye Reset y Aborted.
elm_core.ConnectionResetError = ConnectionError

if __name__ == "__main__":
    sys.argv[0] = "elm"
    main()
