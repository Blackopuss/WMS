import type { Metadata } from "next";
import Link from "next/link";

import { LEGAL_DOCUMENTS } from "@/platform/legal";

import { SITE } from "../content";
import { LegalDocument } from "../legal-document";

export const metadata: Metadata = {
  title: "Términos y condiciones",
  description: "Condiciones de uso del servicio WMS.",
};

const link = "font-medium text-primary underline-offset-4 hover:underline";

const mail = (
  <a className={link} href={`mailto:${SITE.contactEmail}`}>
    {SITE.contactEmail}
  </a>
);

export default function TermsPage() {
  return (
    <LegalDocument
      eyebrow="Legal"
      title={LEGAL_DOCUMENTS.terms.title}
      version={LEGAL_DOCUMENTS.terms.version}
      intro={
        <p>
          Estos términos regulan el uso de {SITE.name}, un servicio en línea
          para gestionar los almacenes, el inventario, las compras y la
          producción de una empresa. Al crear una cuenta los aceptas a nombre
          propio y de la empresa que registras.
        </p>
      }
      sections={[
        {
          id: "servicio",
          title: "El servicio",
          body: (
            <>
              <p>
                {SITE.name} se usa desde el navegador, sin instalar nada. Se
                contrata por módulos:
              </p>
              <ul>
                <li>
                  <strong>Inventario</strong> (siempre incluido): almacenes,
                  ubicaciones, productos y sus presentaciones, lotes y series,
                  entradas, salidas, ajustes y conteos, tareas del almacén,
                  pedidos de salida, surtido, empaque, embarques, devoluciones
                  de clientes, traslados, e importación y exportación en Excel.
                </li>
                <li>
                  <strong>Compras</strong> (opcional): proveedores, solicitudes
                  y órdenes de compra en PDF y por correo, recepción de
                  mercancía, devoluciones, sugerencias de qué pedir y reportes.
                </li>
                <li>
                  <strong>Producción</strong> (opcional): recetas con versiones
                  y órdenes de producción que apartan sus materiales.
                </li>
                <li>
                  <strong>Calidad</strong> (opcional, solo junto con
                  Producción): planes de inspección por producto y catálogo de
                  defectos.
                </li>
              </ul>
              <p>
                Estamos en lanzamiento: podemos mejorar o cambiar funciones,
                cuidando no quitarte nada que uses sin avisarte antes.
              </p>
            </>
          ),
        },
        {
          id: "planes",
          title: "Planes",
          body: (
            <ul>
              <li>
                Cada plan fija cuántos <strong>productos activos</strong> puedes
                tener (los archivados no cuentan) y cuántas personas incluye.
                Las ubicaciones y los movimientos no tienen límite. Lo que
                incluye cada nivel está en la página de{" "}
                <Link className={link} href="/precios">
                  precios
                </Link>
                .
              </li>
              <li>
                Al llegar al límite sigues trabajando con lo que ya tienes; para
                dar de alta más productos subes de nivel o archivas lo que ya no
                manejas.
              </li>
              <li>
                Para más personas, más productos o un plan a tu medida,
                escríbenos a {mail}.
              </li>
            </ul>
          ),
        },
        {
          id: "cuenta",
          title: "Tu cuenta y tu equipo",
          body: (
            <ul>
              <li>Debes dar datos verdaderos y mantenerlos al día.</li>
              <li>
                Quien registra la empresa es su <strong>titular</strong>: decide
                quién entra y con qué rol, es la única persona que compra o
                cambia el plan, y responde por el uso que su equipo haga del
                servicio.
              </li>
              <li>
                Cada persona es responsable de su contraseña. La verificación en
                dos pasos es obligatoria para titulares y administradores.
                Avísanos de inmediato si sospechas un acceso indebido.
              </li>
            </ul>
          ),
        },
        {
          id: "uso",
          title: "Uso aceptable",
          body: (
            <>
              <p>No está permitido:</p>
              <ul>
                <li>Intentar acceder a información de otras empresas.</li>
                <li>
                  Probar la seguridad, saturar o automatizar el servicio sin
                  nuestro permiso por escrito.
                </li>
                <li>
                  Usarlo para actividades ilícitas o para enviar correos que no
                  sean de tu operación con tus proveedores.
                </li>
              </ul>
              <p>
                Podemos suspender una cuenta que incumpla estas reglas, avisando
                al titular cuando sea posible.
              </p>
            </>
          ),
        },
        {
          id: "datos",
          title: "Tus datos",
          body: (
            <ul>
              <li>
                La información que capturas (productos, existencias,
                movimientos, proveedores y órdenes) es de tu empresa. Puedes
                exportarla en Excel en cualquier momento, también cuando tu plan
                ya venció.
              </li>
              <li>
                La usamos solo para prestarte el servicio: no la vendemos ni la
                compartimos. Hacemos respaldos cifrados periódicos.
              </li>
              <li>
                Los datos personales se tratan conforme al{" "}
                <Link className={link} href="/privacidad">
                  aviso de privacidad
                </Link>
                .
              </li>
            </ul>
          ),
        },
        {
          id: "correos",
          title: "Correos a tus proveedores",
          body: (
            <p>
              Cuando envías una orden de compra por correo, sale desde{" "}
              {SITE.name} a nombre de tu empresa y las respuestas llegan a quien
              la envió. Tu empresa es responsable del contenido de la orden y de
              tener permiso para escribir a ese proveedor.
            </p>
          ),
        },
        {
          id: "soporte",
          title: "Soporte",
          body: (
            <>
              <p>Para cualquier duda o problema escríbenos a {mail}.</p>
              <p>
                Si para ayudarte necesitamos ver tu información, el titular nos
                da acceso desde Configuración, por 24 horas y solo para mirar:
                no podemos cambiar ni descargar nada. El titular puede quitarlo
                en cualquier momento, y cada entrada y salida queda en la
                bitácora de la empresa. Sin ese permiso no entramos a tu
                empresa.
              </p>
            </>
          ),
        },
        {
          id: "pagos",
          title: "Precios y pagos",
          body: (
            <ul>
              <li>
                Los precios están en pesos mexicanos e incluyen IVA: lo que ves
                es lo que pagas.
              </li>
              <li>
                El plan se paga por adelantado, por los meses que acordemos, por
                transferencia bancaria. No cobramos en línea ni guardamos datos
                de tarjetas.
              </li>
              <li>
                Nada se cobra en automático: al terminar los meses pagados, tú
                decides si renuevas. Para renovar, o para cambiar de nivel o de
                módulos, escríbenos a {mail}.
              </li>
              <li>
                El plan se activa cuando confirmamos tu pago, y te avisamos por
                correo.
              </li>
              <li>
                El precio que contratas se mantiene mientras renueves tu plan;
                un cambio de precio aplica a contrataciones nuevas o te lo
                avisamos con anticipación.
              </li>
            </ul>
          ),
        },
        {
          id: "vencimiento",
          title: "Si tu plan vence",
          body: (
            <p>
              Si no renuevas, o si dejas un módulo, la empresa queda en modo
              consulta: ves y exportas todo, pero no registras cambios. Nada se
              borra; al renovar sigues donde te quedaste.
            </p>
          ),
        },
        {
          id: "reembolsos",
          title: "Reembolsos",
          body: (
            <ul>
              <li>
                Puedes pedir el reembolso de un pago dentro de los 10 días
                naturales siguientes, escribiendo a {mail} desde el correo del
                titular.
              </li>
              <li>
                Si lo pides en ese plazo te devolvemos el importe completo;
                después, solo los meses completos que todavía no empiezan.
              </li>
              <li>
                El reembolso se hace por transferencia, en un plazo de hasta 20
                días hábiles. Al reembolsarse, la vigencia del plan se ajusta a
                lo que sí se pagó.
              </li>
              <li>
                Tus datos no se borran por pedir un reembolso: al terminar la
                vigencia, la empresa queda en solo lectura y puedes exportarlos.
              </li>
            </ul>
          ),
        },
        {
          id: "baja",
          title: "Dar de baja tu empresa",
          body: (
            <p>
              Si quieres que borremos la información de tu empresa, el titular
              nos lo pide a {mail} desde el correo de su cuenta. Antes te
              recomendamos exportarla. Conservaremos solo lo que la ley o la
              seguridad exigen, como la bitácora y los comprobantes de pago.
            </p>
          ),
        },
        {
          id: "disponibilidad",
          title: "Disponibilidad y responsabilidad",
          body: (
            <>
              <p>
                Trabajamos para que el servicio esté disponible y respaldado,
                pero puede haber interrupciones por mantenimiento o causas fuera
                de nuestro control. Cuando las planeemos, avisaremos con
                anticipación.
              </p>
              <p>
                {SITE.name} es una herramienta de registro: las cifras dependen
                de lo que tu equipo captura, y las decisiones de compra, venta y
                contabilidad son de tu empresa. Nuestra responsabilidad se
                limita a lo que pagaste por el servicio en los 12 meses
                anteriores al problema.
              </p>
            </>
          ),
        },
        {
          id: "propiedad",
          title: "Propiedad intelectual",
          body: (
            <p>
              El software, la marca y el diseño de {SITE.name} son de{" "}
              {SITE.legalName}. La suscripción te da derecho a usarlo, no a
              copiarlo ni revenderlo.
            </p>
          ),
        },
        {
          id: "cambios",
          title: "Cambios y legislación",
          body: (
            <p>
              Podemos actualizar estos términos. Los cambios importantes se
              avisan por correo antes de aplicar, y al entrar te pediremos
              aceptar la versión nueva. Estos términos se rigen por las leyes de
              los Estados Unidos Mexicanos. Dudas: {mail}.
            </p>
          ),
        },
      ]}
    />
  );
}
