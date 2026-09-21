#!/bin/sh
# Extrae el <script> principal de index.html (el bloque que empieza en la línea "  <script>"
# a solas y termina en "  </script>") y lo pasa por node --check.
awk '/^  <script>$/{f=1;next}/^  <\/script>$/{f=0}f' index.html > /tmp/bank-app.js && node --check /tmp/bank-app.js && echo "OK sintaxis"
