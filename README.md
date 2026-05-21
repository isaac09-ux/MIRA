# MIRA

**Interfaz del sistema de analítica de Las Chispas.**

CLARA *ve* — procesa el video. MIRA es por donde **tú** miras hacia CLARA: la
cara del sistema. Esta es la **Fase 1 — el calibrador de cancha**.

> CLARA y MIRA son dos repos distintos. CLARA es el motor (Python, corre en tu
> compu). MIRA es la interfaz (Next.js, vive en Vercel). No se mezclan.

---

## Qué hace la Fase 1

El cuello de botella de CLARA es la **calibración**: convertir píxeles del video
en coordenadas reales de cancha (homografía). Si la calibración está corrida, el
topdown sale distorsionado y todo el análisis de abajo vale lo que valga ese
mapeo.

MIRA resuelve eso:

1. Cargas un **frame** de tu video (una imagen).
2. Marcas las **4 esquinas** de la cancha, en orden. Cada vez que mueves el
   cursor aparece una **lupa con zoom** para clavar el punto exacto — incluso
   con jugadoras tapando la esquina.
3. Puedes **arrastrar** cualquier esquina para corregir.
4. **Verificación en vivo:** apenas tienes las 4 esquinas, MIRA dibuja la cancha
   proyectada de vuelta sobre el frame, en cian. Si las líneas cian calzan con
   las líneas reales de la cancha, calibraste bien. Si no, arrastras y lo ves
   al instante — sin correr todo el pipeline para descubrirlo.
5. Exporta **`cal.json`** — el archivo exacto que come CLARA.

La matemática de homografía corre en el navegador, en JavaScript puro
(`lib/homography.js`). Es idéntica a `cv2.findHomography` — verificado a 6
decimales.

```
frame.png  →  [ MIRA ]  →  cal.json  →  python src/clara.py --calibration cal.json
```

---

## Correr en tu compu

Necesitas Node.js (ya tienes v24).

```bash
npm install      # una sola vez — instala dependencias
npm run dev      # arranca en http://localhost:3000
```

Abre esa URL en el navegador y ya estás calibrando. Para parar: `Ctrl + C`.

---

## Subir a GitHub y desplegar en Vercel

La idea de Vercel: **conectas el repo de GitHub una vez**, y de ahí cada
`git push` reconstruye y publica el sitio solo, en una URL en vivo. Sin
servidores, sin FTP.

### 1 — Crear el repo en GitHub

En github.com → **New repository** → nombre `MIRA` → **Private** → Create.
No marques "add README" (este repo ya lo trae).

### 2 — Subir el código

Desde la carpeta de MIRA, en tu terminal:

```bash
git init
git add .
git commit -m "MIRA v0.1 — calibrador de cancha (Fase 1)"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/MIRA.git
git push -u origin main
```

### 3 — Conectar Vercel

1. Entra a [vercel.com](https://vercel.com) y haz login con tu cuenta de GitHub.
2. **Add New… → Project**.
3. Te lista tus repos de GitHub → elige **MIRA** → **Import**.
4. Vercel detecta Next.js solo. No cambies nada. → **Deploy**.
5. En ~1 minuto te da una URL en vivo (algo como `mira-xxxx.vercel.app`).

### 4 — El flujo de aquí en adelante

Ya conectado, cada vez que cambies algo:

```bash
git add .
git commit -m "lo que cambiaste"
git push
```

Vercel ve el push, reconstruye, y actualiza la URL en vivo solo. Eso es todo.

---

## Estructura

```
MIRA/
├── app/
│   ├── layout.js          — layout raíz
│   ├── page.js            — página principal
│   └── globals.css        — lenguaje visual (paleta CLARA)
├── components/
│   └── Calibrator.js      — el calibrador completo (Fase 1)
├── lib/
│   └── homography.js      — solver de homografía en JS puro
├── package.json
└── next.config.js
```

---

## Roadmap

- **Fase 1 — Calibrador** ✅ *(este release)*
- **Fase 2 — Visor de resultados** — subir `scouting_data.json`, ver el
  topdown, las zonas y la lectura de LUCIA renderizada. Misma app, otra pestaña.
- **Fase 3 — Auto-detección de líneas** — Hough propone las esquinas, tú solo
  confirmas. Y, más adelante, lo que pida el sistema.

---

*MIRA es la interfaz de LUCIA · Las Chispas. "Until the last star falls."*
