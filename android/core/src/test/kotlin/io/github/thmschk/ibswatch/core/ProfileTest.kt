package io.github.thmschk.ibswatch.core

import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * IBS5 liefert den Namen nur als einen Freitext in `name1` ("Nachname, Vorname");
 * `name2` ist leer. Der Vorname muss also zerlegt werden — und darf im Zweifel
 * lieber fehlen als falsch sein: eine Meldung mit fremdem Namen waere schlimmer
 * als eine ohne.
 */
class ProfileTest {

    private fun firstNameOf(name: String) = Profile(name = name, institution = "").firstName

    @Test
    fun `Nachname Komma Vorname`() {
        assertEquals("Mia", firstNameOf("Muster, Mia"))
    }

    @Test
    fun `zusaetzliche Leerzeichen stoeren nicht`() {
        assertEquals("Mia", firstNameOf("Muster ,  Mia  "))
    }

    @Test
    fun `Doppelname bleibt vollstaendig`() {
        assertEquals("Anna Lena", firstNameOf("Müller, Anna Lena"))
    }

    @Test
    fun `ohne Komma wird das letzte Wort genommen`() {
        assertEquals("Mia", firstNameOf("Muster Mia"))
    }

    @Test
    fun `leerer Name ergibt leeren Vornamen`() {
        assertEquals("", firstNameOf(""))
        assertEquals("", firstNameOf("   "))
    }
}
