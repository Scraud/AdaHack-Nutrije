# Pravila načrtovanja

- Naloga ima en prevzem, eno človeško določeno ciljno ustanovo in eno vozilo. Ustreznost vključuje vrsto naloge, zahtevano opremo in kapaciteto. Oprema ali potniki različnih nalog se ne združujejo.
- Prihod pomeni prihod na cilj. Čas predaje in čiščenja podaljša zasedenost vozila. Prevzem in prihod upoštevata obvezne roke. Želeni prihod določa napovedano zamudo.
- Vozilo začne na zadnji potrjeni lokaciji. Če je v teku zadnja dodelitev, je prihodnji start njen cilj, po koncu predaje in čiščenja. Izračun ohrani opravljene, začete in izrecno zaklenjene dodelitve. Blokiran začeti prevoz zahteva ročno koordinacijo in prepreči potrditev kandidata.
- Ustanove imajo sintetično kvoto prihodov za dan. Zamrznjene rezervacije se prištejejo enkrat. Ob težavi s kapaciteto naloga ostane nedodeljena ali označena za koordinacijo.
- CP-SAT najprej v vrstnem redu P1, P2, P3 poišče največjo pokritost v danem proračunu. Strategije nato ohranijo najdeno pokritost in optimizirajo zamudo, spremembe oziroma najnižjo uporabno rezervo. Status izračuna in dokaz pokritosti sta ločena. Proračun je tri sekunde za pokritost in dve na strategijo.
- Neodvisni validator preveri vsak sestavljen kandidat. SQLite v isti transakciji preveri osnovno verzijo, revizijo, posnetek vhodov in dodelitve ter zapiše odločitev. Ponovljena potrditev vrne isto odločitev.
- Vsak planski posnetek v demu uporabi takrat veljavne motnje in trenutni učinek ohrani za preostanek izračunanega horizonta. Naslednji izračun po izteku uporabi osvežene razmere. Zapora izključi presečne relacije, zastoj jih podaljša. Osnovna razdalja je Haversine z množiteljem 1,3 in povprečno hitrostjo 34 km/h.
- Primerjava ob motnji ponovno oceni obstoječe poti z isto matriko. Številke o napovedanih zamudah in pokritosti so ločene od dejanskih simuliranih prevzemov in prihodov. Prestavljene napovedi še zahtevajo potrditev in niso dejansko opravljene vožnje.
