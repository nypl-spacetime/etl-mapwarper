# Space/Time ETL script: Mapwarper

[ETL](https://en.wikipedia.org/wiki/Extract,_transform,_load) script for NYPL's [NYC Space/Time Direcory](http://spacetime.nypl.org/).

## Details

<table>
  <tbody>

    <tr>
      <td>ID</td>
      <td><code>mapwarper</code></td>
    </tr>

    <tr>
      <td>Title</td>
      <td>Mapwarper</td>
    </tr>

    <tr>
      <td>Description</td>
      <td></td>
    </tr>

    <tr>
      <td>License</td>
      <td>CC0</td>
    </tr>

    <tr>
      <td>Author</td>
      <td>NYPL</td>
    </tr>

    <tr>
      <td>Website</td>
      <td><a href="http://maps.nypl.org/">http://maps.nypl.org/</a></td>
    </tr>

    <tr>
      <td>Editor</td>
      <td>Bert Spaan</td>
    </tr>
  </tbody>
</table>

## Available steps

  - `download`
  - `transform`

## Usage

```
git clone https://github.com/nypl-spacetime/etl-mapwarper.git /path/to/etl-scripts
cd /path/to/etl-scripts/etl-mapwarper
npm install

spacetime-etl mapwarper [<step>]
```

See http://github.com/nypl-spacetime/spacetime-etl for information about Space/Time's ETL tool. More Space/Time ETL scripts [can be found on GitHub](https://github.com/search?utf8=%E2%9C%93&q=org%3Anypl-spacetime+etl-&type=Repositories&ref=advsearch&l=&l=).

# Data

The dataset created by this ETL script's `transform` step can be found in the [data section of the NYC Space/Time Directory website](http://spacetime.nypl.org/#data-mapwarper).
