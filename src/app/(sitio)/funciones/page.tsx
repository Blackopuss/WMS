import {
  ArrowLeftRight,
  Bell,
  Boxes,
  CalendarClock,
  Camera,
  ClipboardCheck,
  ClipboardList,
  Container,
  Download,
  Factory,
  FileSpreadsheet,
  FileText,
  Forklift,
  GitBranch,
  History,
  KeyRound,
  Layers,
  ListChecks,
  ListTree,
  Mail,
  MapPinned,
  PackageCheck,
  PackageMinus,
  PackageOpen,
  Plug,
  Printer,
  Repeat,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Stamp,
  TabletSmartphone,
  TrendingDown,
  TriangleAlert,
  Truck,
  Undo2,
  Users,
  Warehouse,
  Wrench,
} from "lucide-react";
import type { Metadata } from "next";

import { CtaBand, PageHero, Section } from "../sections";

export const metadata: Metadata = {
  title: "Funciones",
  description:
    "Recepción, acomodo, surtido, empaque y embarques; lotes, series y conteos; tareas para el piso; compras, recetas y órdenes de producción, e inspección de calidad.",
};

type Feature = { icon: typeof Boxes; title: string; text: string };

/**
 * Only what the product does today (AGENTS.md, «Hechos»). What is still
 * being built goes in `soon`, never as a feature.
 */
const GROUPS: {
  id: string;
  name: string;
  intro: string;
  module?: string;
  features: Feature[];
  soon?: string;
}[] = [
  {
    id: "almacen",
    name: "Almacén",
    module: "Inventario",
    intro:
      "Qué tienes, cuánto y dónde, en uno o varios almacenes, con un historial que no se puede maquillar.",
    features: [
      {
        icon: Warehouse,
        title: "Varios almacenes",
        text: "Cada persona trabaja en el suyo y puede quedar limitada a ciertos almacenes o zonas.",
      },
      {
        icon: MapPinned,
        title: "Ubicaciones a tu medida",
        text: "Los niveles los nombras tú (zona, pasillo, rack, nivel…), con código para escanear, capacidad y restricciones.",
      },
      {
        icon: Boxes,
        title: "Productos con presentaciones",
        text: "Clave, código de barras, categoría y unidad. Cajas o paquetes con su contenido; si cambia, lo anterior se respeta.",
      },
      {
        icon: CalendarClock,
        title: "Lotes y caducidad",
        text: "Lo que caduca antes sale antes, siempre. Aviso de lo que está por caducar.",
      },
      {
        icon: ListTree,
        title: "Números de serie y rastreo",
        text: "Sigue una serie, un lote o un pedido de punta a punta: de qué proveedor llegó y en qué embarque salió.",
      },
      {
        icon: Layers,
        title: "Estados de la mercancía",
        text: "Disponible, en inspección, en cuarentena, dañado o en restauración: solo lo disponible se surte.",
      },
      {
        icon: ArrowLeftRight,
        title: "Movimientos con historial",
        text: "Entradas, salidas, cambios de lugar y ajustes con quién, cuándo y por qué. Un error se corrige con una reversa, nunca borrando.",
      },
      {
        icon: FileSpreadsheet,
        title: "Importación y exportación",
        text: "Catálogo, existencias, salidas y pedidos desde Excel o CSV, revisados fila por fila. Tus datos salen cuando quieras.",
      },
    ],
  },
  {
    id: "entradas",
    name: "Recibir y guardar",
    module: "Inventario",
    intro: "Lo que llega se recibe, se revisa y queda en su lugar.",
    features: [
      {
        icon: PackageOpen,
        title: "Recepción",
        text: "Contra la orden de compra, en partes, por lote o serie. Lo que llega dañado queda aparte.",
      },
      {
        icon: Stamp,
        title: "Inspección al recibir",
        text: "Los productos que tú marques entran en inspección y no se usan hasta que alguien decide.",
      },
      {
        icon: Forklift,
        title: "Acomodo recomendado",
        text: "Una tarea lleva lo recibido al lugar que el sistema recomienda según capacidad y lo que ya hay ahí.",
      },
      {
        icon: Container,
        title: "Tarimas y contenedores",
        text: "Recibe en tarima, muévela entera y desármala cuando haga falta, sin perder el detalle de lo que lleva.",
      },
      {
        icon: Repeat,
        title: "Cross-docking",
        text: "Lo que llega y ya espera un pedido va directo a surtido, sin pasar por el estante.",
      },
      {
        icon: Undo2,
        title: "Devoluciones de clientes",
        text: "Lo devuelto entra en inspección y alguien decide: a disponible, a dañado o a restauración.",
      },
    ],
  },
  {
    id: "salidas",
    name: "Surtir y despachar",
    module: "Inventario",
    intro: "Del pedido al camión, con cada paso a la vista.",
    features: [
      {
        icon: ClipboardList,
        title: "Pedidos de salida",
        text: "Captúralos, impórtalos de Excel o recíbelos por la API. Al liberarlos, la mercancía queda apartada.",
      },
      {
        icon: ListChecks,
        title: "Surtido por pedido o por olas",
        text: "Tareas con el recorrido ordenado por ubicación; en olas, juntas varias órdenes por estante.",
      },
      {
        icon: PackageCheck,
        title: "Empaque con verificación",
        text: "Cada pieza se escanea al empacar en su bulto; lo que falta queda registrado con su motivo.",
      },
      {
        icon: Truck,
        title: "Embarques",
        text: "Agrupa pedidos, anota transportista y quién se lo lleva, e imprime la hoja de embarque.",
      },
      {
        icon: ArrowLeftRight,
        title: "Traslados entre almacenes",
        text: "Lo enviado queda en camino hasta que el otro almacén lo recibe, completo o con diferencias.",
      },
      {
        icon: Printer,
        title: "Etiquetas",
        text: "Ubicaciones, productos, lotes, tarimas y embarques, con código de barras o QR, en hoja carta o en etiquetadora.",
      },
    ],
  },
  {
    id: "control",
    name: "Control de existencias",
    module: "Inventario",
    intro: "Para que el número del sistema sea el del estante.",
    features: [
      {
        icon: ClipboardCheck,
        title: "Conteos cíclicos",
        text: "Programas por zona o por clase ABC que generan los conteos de cada día. La diferencia se calcula bien aunque haya movimientos mientras cuentas.",
      },
      {
        icon: TrendingDown,
        title: "Mínimos y reposición",
        text: "Avisos de lo que se acaba y tareas para reponer las ubicaciones de surtido desde el almacenaje.",
      },
      {
        icon: ShieldCheck,
        title: "Aprobaciones",
        text: "Los ajustes grandes y la aplicación de conteos pueden esperar la autorización de quien tú decidas.",
      },
      {
        icon: PackageMinus,
        title: "Desecho con motivo",
        text: "Lo dañado o rechazado sale del inventario con su motivo y queda en el historial.",
      },
      {
        icon: History,
        title: "Resumen del día",
        text: "Entradas, salidas, tareas y pedidos de hoy, por persona y por almacén.",
      },
    ],
  },
  {
    id: "piso",
    name: "Equipo en piso",
    module: "Inventario",
    intro:
      "Cada quien sabe qué le toca, desde el teléfono o una terminal compartida.",
    features: [
      {
        icon: ListChecks,
        title: "Tareas",
        text: "Traslados, acomodos, surtidos y reposiciones con un botón grande para el siguiente paso.",
      },
      {
        icon: Smartphone,
        title: "App instalable y cámara",
        text: "Se instala desde el navegador. Escanea con lector USB o con la cámara de un teléfono Android.",
      },
      {
        icon: TabletSmartphone,
        title: "Terminales con PIN",
        text: "Un equipo compartido en el piso: cada persona entra con su PIN y solo ve lo suyo.",
      },
      {
        icon: TriangleAlert,
        title: "Incidencias",
        text: "Cualquiera reporta un problema, con foto si hace falta, y alguien lo atiende.",
      },
      {
        icon: Camera,
        title: "Fotos de evidencia",
        text: "Se guardan sin la ubicación del teléfono y solo las ve quien puede ver el registro.",
      },
      {
        icon: Wrench,
        title: "Equipos del almacén",
        text: "Montacargas y demás equipos, con su mantenimiento; una tarea puede pedir un tipo de equipo.",
      },
      {
        icon: GitBranch,
        title: "Procesos por etapas",
        text: "Defines las etapas de tus embarques u órdenes de producción y quién hace cada una.",
      },
      {
        icon: Bell,
        title: "Avisos",
        text: "En la app y, si quieres, por correo, con un resumen diario de lo que pide atención.",
      },
    ],
  },
  {
    id: "compras",
    name: "Compras",
    module: "Compras",
    intro:
      "Del «hay que pedir» a la mercancía en el estante, sin perder de vista lo que falta.",
    features: [
      {
        icon: Users,
        title: "Proveedores",
        text: "Datos de contacto, RFC y qué productos te vende cada uno, con su clave de catálogo.",
      },
      {
        icon: ClipboardList,
        title: "Solicitudes de compra",
        text: "El almacén pide lo que hace falta y Compras lo convierte en órdenes, una por proveedor.",
      },
      {
        icon: FileText,
        title: "Órdenes en PDF y por correo",
        text: "Arma la orden por caja o por pieza, descárgala o mándala desde el sistema.",
      },
      {
        icon: PackageMinus,
        title: "Sugerencia de compra",
        text: "Lo que falta para llegar a tus mínimos, descontando lo que ya viene en camino.",
      },
      {
        icon: RotateCcw,
        title: "Devoluciones al proveedor",
        text: "Por recepción, desde lo disponible, dañado o rechazado, con su lote y sus series.",
      },
      {
        icon: Download,
        title: "Costos y reportes",
        text: "Último costo, comparación de proveedores, pendientes y compras por proveedor. Solo lo ve quien debe.",
      },
    ],
  },
  {
    id: "produccion",
    name: "Producción",
    module: "Producción",
    intro: "Lo que fabricas, armas o empacas, con sus materiales apartados.",
    features: [
      {
        icon: ListTree,
        title: "Recetas con versiones",
        text: "Materiales, merma esperada y lo que sale, con su parte del costo. Un cambio crea una versión nueva.",
      },
      {
        icon: Factory,
        title: "Órdenes de producción",
        text: "Calculan los materiales con la receta vigente y los apartan al liberarse; lo que caduca antes, primero.",
      },
      {
        icon: Forklift,
        title: "Surtido a producción",
        text: "Si lo eliges, tareas llevan los materiales del almacén al área de producción.",
      },
      {
        icon: Users,
        title: "Roles de producción",
        text: "Operario y encargado de producción, con lo justo para su trabajo.",
      },
    ],
    soon: "Próximamente: reporte de lo producido con su consumo y su costo, y cierre de la orden.",
  },
  {
    id: "calidad",
    name: "Calidad",
    module: "Calidad (con Producción)",
    intro: "Qué se revisa de cada producto y qué cuenta como defecto.",
    features: [
      {
        icon: ClipboardCheck,
        title: "Planes de inspección",
        text: "Por producto: revisión completa o por muestra, y puntos de sí o no, rango, opción o con foto.",
      },
      {
        icon: TriangleAlert,
        title: "Catálogo de defectos",
        text: "Los defectos de tu empresa con su gravedad: menor, mayor o crítica.",
      },
      {
        icon: Users,
        title: "Inspector de calidad",
        text: "Un rol propio para quien revisa, también en terminales con PIN.",
      },
    ],
    soon: "Próximamente: registrar la inspección y liberar o rechazar lo producido o recibido.",
  },
  {
    id: "seguridad",
    name: "Equipo y seguridad",
    intro: "Cada persona ve y hace solo lo que le toca.",
    features: [
      {
        icon: Users,
        title: "Once roles listos",
        text: "De administración y gerencia al almacenista, el montacarguista, compras, producción y calidad.",
      },
      {
        icon: KeyRound,
        title: "Verificación en dos pasos",
        text: "Obligatoria para titular y administración. Historial de accesos y aviso de entradas desde un equipo nuevo.",
      },
      {
        icon: ShieldCheck,
        title: "Bitácora",
        text: "Cambios de equipo, ajustes y descargas quedan registrados y no se pueden borrar.",
      },
      {
        icon: SlidersHorizontal,
        title: "Se adapta a tu operación",
        text: "Ajustes por empresa y campos personalizados para productos, ubicaciones y proveedores.",
      },
      {
        icon: Plug,
        title: "API y webhooks",
        text: "Consulta existencias, crea pedidos desde tu sistema y recibe avisos firmados de lo que pasa.",
      },
      {
        icon: Mail,
        title: "Sin perder nada",
        text: "Si dejas un módulo o tu plan vence, todo queda en modo consulta y lo puedes exportar.",
      },
    ],
  },
];

export default function FeaturesPage() {
  return (
    <>
      <PageHero
        eyebrow="Funciones"
        title="Todo lo que tu almacén necesita, nada que estorbe"
      >
        Diseñado para almacenes reales: cajas que salen por pieza, pedidos que
        llegan incompletos y gente que cuenta mientras otros surten. Inventario
        trae todo el almacén; Compras, Producción y Calidad se agregan.
      </PageHero>

      <nav
        aria-label="Grupos de funciones"
        className="sticky top-16 z-30 border-b bg-background/85 backdrop-blur-lg"
      >
        <ul className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4 sm:px-6">
          {GROUPS.map((group) => (
            <li key={group.id}>
              <a
                href={`#${group.id}`}
                className="inline-flex h-12 items-center px-3 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground"
              >
                {group.name}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      {GROUPS.map((group, index) => (
        <Section
          key={group.id}
          id={group.id}
          className={index % 2 === 1 ? "bg-card/60" : undefined}
        >
          <div className="grid gap-10 lg:grid-cols-[0.8fr_2fr]">
            <div data-reveal className="lg:sticky lg:top-36 lg:self-start">
              {group.module && (
                <p className="text-sm font-medium text-primary">
                  {group.module}
                </p>
              )}
              <h2 className="text-3xl font-semibold tracking-tight">
                {group.name}
              </h2>
              <p className="mt-3 text-muted-foreground">{group.intro}</p>
              {group.soon && (
                <p className="mt-4 rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
                  {group.soon}
                </p>
              )}
            </div>
            <ul data-reveal="stagger" className="grid gap-4 sm:grid-cols-2">
              {group.features.map(({ icon: Icon, title, text }) => (
                <li
                  key={title}
                  className="group rounded-2xl border bg-card p-5 shadow-sm transition-shadow duration-300 hover:shadow-md"
                >
                  <span className="grid size-10 place-items-center rounded-xl bg-accent text-accent-foreground transition-transform duration-300 group-hover:scale-110 motion-reduce:transition-none">
                    <Icon className="size-5" aria-hidden="true" />
                  </span>
                  <h3 className="mt-4 font-semibold">{title}</h3>
                  <p className="mt-1.5 text-sm text-muted-foreground">{text}</p>
                </li>
              ))}
            </ul>
          </div>
        </Section>
      ))}

      <CtaBand />
    </>
  );
}
