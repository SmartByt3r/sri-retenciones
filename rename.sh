#!/bin/bash

# Ruta base donde está la carpeta "Comprobantes"
BASE_DIR="./1792734134001/Comprobantes/2024"

# Iterar sobre cada carpeta de mes (Enero, Febrero, etc.)
for month_dir in "$BASE_DIR"/*; do
    # Saltar si no es un directorio
    [ -d "$month_dir" ] || continue

    # Iterar sobre cada subcarpeta dentro del mes
    for comprobante_dir in "$month_dir"/*; do
        # Saltar si no es un directorio (como IVA.xlsx o raw_result.json)
        [ -d "$comprobante_dir" ] || continue

        # Obtener nombre de la subcarpeta (el número largo)
        folder_name=$(basename "$comprobante_dir")

        # Buscar el archivo sin extensión que comience con "Comprobante de"
        file=$(find "$comprobante_dir" -maxdepth 1 -type f -name "Comprobante de*" ! -name "*.*" | head -n 1)

        if [ -n "$file" ]; then
            dest_file="$month_dir/${folder_name}.pdf"
            echo "Renombrando y moviendo $file -> $dest_file"
            mv "$file" "$dest_file"
        else
            echo "⚠️  No se encontró archivo en $comprobante_dir"
        fi

        # Intentar eliminar la carpeta si está vacía
        rmdir "$comprobante_dir" 2>/dev/null || echo "ℹ️  No se pudo eliminar $comprobante_dir (no está vacía)"
    done
done
