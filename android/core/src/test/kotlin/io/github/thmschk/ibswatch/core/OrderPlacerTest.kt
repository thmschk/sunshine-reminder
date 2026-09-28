package io.github.thmschk.ibswatch.core

import java.time.LocalDate
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer

class OrderPlacerTest {

    private val plan = WeekplanParser.parse(
        checkNotNull(javaClass.getResourceAsStream("/weekplan_kw42_order.html")).bufferedReader().readText(),
    )
    private val mon = LocalDate.of(2026, 10, 12)
    private val tue = LocalDate.of(2026, 10, 13)

    private val server = MockWebServer()

    @AfterTest
    fun tearDown() = server.shutdown()

    private fun loggedInClient(): IbsClient {
        server.enqueue(MockResponse().setBody("""{"token":"abc"}"""))
        return IbsClient(baseUrl = server.url("/ibs5").toString()).also {
            it.login("1", "x")
            server.takeRequest()
        }
    }

    private fun cart(total: Int, status: String = "OK", message: String? = null) =
        MockResponse().setBody(
            """{"totalItemsInCart":$total,"messageStatus":"$status","message":${message?.let { "\"$it\"" } ?: "null"}}""",
        )

    private fun line(date: LocalDate, line: String) =
        plan.statusFor(date).entries.single { it.menuLineId == line }

    @Test
    fun `Parser liest Gruppe, Linie und Kundennummer aus dem Markup`() {
        val e = line(mon, "828")
        assertEquals("16", e.menuGroupId)
        assertEquals("1000", e.customerId)
        assertTrue(e.selectable)
        assertFalse(line(mon, "831").selectable, "Kaltverpflegung ist readonly ohne onclick")
        assertEquals(OrderState.IN_CART, plan.statusFor(tue).state)
        assertEquals(OrderState.NOT_ORDERED, plan.statusFor(mon).state)
    }

    @Test
    fun `SaveOrder bekommt das JSON der Webseite`() {
        val client = loggedInClient()
        server.enqueue(cart(1))
        client.addToCart(line(mon, "828"))
        val req = server.takeRequest()
        assertEquals("/ibs5/Mealplan/SaveOrder", req.path)
        assertEquals(
            """{"mealOrderQuantity":{"CustomerId":"1000","ServeDate":"2026-10-12","MenuGroupId":"16",""" +
                """"MenuLineId":"828","QuantityInShoppingCart":1,"ShoppingCartOrderType":"I"}}""",
            req.body.readUtf8(),
        )
        assertTrue(req.getHeader("Content-Type")!!.startsWith("application/json"))
    }

    @Test
    fun `Probelauf legt in den Warenkorb, schickt nicht ab und raeumt auf`() {
        val client = loggedInClient()
        server.enqueue(cart(0)) // ClearCart Mo
        server.enqueue(cart(1)) // SaveOrder Mo
        server.enqueue(cart(1)) // ClearCart Di (entfernt alten Eintrag)
        server.enqueue(cart(2)) // SaveOrder Di
        server.enqueue(cart(1)) // Rollback Mo
        server.enqueue(cart(0)) // Rollback Di
        server.enqueue(cart(1)) // alter Di-Eintrag zurueck

        val result = OrderPlacer(client).place(
            listOf(line(mon, "828"), line(tue, "829")),
            dryRun = true,
            previouslyInCart = listOf(line(tue, "828")),
        ) { emptyList() }

        assertIs<PlaceResult.DryRunOk>(result)
        val reqs = (1..7).map { server.takeRequest() }
        assertFalse(reqs.any { it.path!!.contains("Cart/Order") }, "Probelauf darf nie abschicken")
        val last = reqs.last()
        assertEquals("/ibs5/Mealplan/SaveOrder", last.path)
        assertTrue(last.body.readUtf8().contains("\"MenuLineId\":\"828\""), "alter Warenkorb-Eintrag wiederhergestellt")
    }

    @Test
    fun `fremder Warenkorb-Inhalt verhindert das Abschicken`() {
        val client = loggedInClient()
        server.enqueue(cart(2))
        server.enqueue(cart(3)) // 3 statt 1: da liegt noch etwas
        server.enqueue(cart(2))

        val result = OrderPlacer(client).place(listOf(line(mon, "828")), dryRun = false) { emptyList() }

        assertIs<PlaceResult.Aborted>(result)
        val paths = (1..3).map { server.takeRequest().path }
        assertFalse(paths.any { it!!.contains("Cart/Order") }, "$paths")
    }

    @Test
    fun `Fehlermeldung des Servers wird durchgereicht`() {
        val client = loggedInClient()
        server.enqueue(cart(0))
        server.enqueue(cart(0, "ERROR", "Die Bestellfrist für diesen Tag ist abgelaufen."))
        server.enqueue(cart(0))

        val result = OrderPlacer(client).place(listOf(line(mon, "828")), dryRun = false) { emptyList() }

        assertIs<PlaceResult.Aborted>(result)
        assertTrue(result.reason.contains("Bestellfrist"), result.reason)
    }

    @Test
    fun `Bestellung wird nach dem Abschicken im Wochenplan nachgeprueft`() {
        val client = loggedInClient()
        server.enqueue(cart(0))
        server.enqueue(cart(1))
        server.enqueue(MockResponse().setBody("""{"MessageStatus":"OK","Message":null}"""))

        val ok = OrderPlacer(client).place(listOf(line(mon, "828")), dryRun = false) {
            listOf(DayStatus(mon, OrderState.ORDERED))
        }
        assertIs<PlaceResult.Ordered>(ok)
        assertEquals("/ibs5/Cart/Order", (1..3).map { server.takeRequest() }.last().path)
    }
}
