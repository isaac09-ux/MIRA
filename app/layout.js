import "./globals.css";

export const metadata = {
  title: "MIRA · CLARA",
  description:
    "MIRA — interfaz del sistema de analítica de Las Chispas. Calibrador de cancha para CLARA.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
